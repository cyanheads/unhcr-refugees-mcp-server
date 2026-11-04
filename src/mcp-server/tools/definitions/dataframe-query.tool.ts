/**
 * @fileoverview unhcr_dataframe_query — one read-only SELECT across the
 * dataframes the unhcr_get_* tools staged. The framework's SQL gate enforces a
 * single SELECT with an allowlisted plan and no file-reading functions; this
 * tool also denies system catalogs, so a caller sees only the tables it holds
 * a handle to. Results carry the attribution UNHCR's terms require, crediting
 * the third-party series recorded for every dataframe the SQL references. A
 * register_as result counts toward the tenant's staging budget and names any
 * dataframes it evicted. `row_limit` is held to the canvas row cap and
 * `preview` to 1,500 rows or `row_limit`, whichever is lower; the clamp mode
 * (`UNHCR_CLAMP_LIMITS`) and the canvas row cap reach the schemas through
 * {@link defineDataframeQueryTool}.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { ConfigSchema } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DATAFRAME_NAME,
  DATAFRAME_NAME_LENGTH,
  getCanvasBridge,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { type CountClamp, clampCount, countSchema } from '../shared/counts.js';
import { blankAsUnset } from '../shared/inputs.js';
import { attributionSchema, STAGING_BUDGET } from '../shared/outputs.js';
import { formatQueryOutput, type QueryOutput } from '../shared/query-output.js';
import { buildAttribution } from '../shared/results.js';

const TOOL_NAME = 'unhcr_dataframe_query';

/** Longest `sql` accepted: DuckDB's parse cost grows with statement length, and the cap bounds it. */
const SQL_MAX_LENGTH = 20_000;
const SQL_CAP = `${SQL_MAX_LENGTH.toLocaleString('en-US')} characters`;

/** Inline rows when `preview` is omitted. */
const PREVIEW_DEFAULT = 25;
/** Most inline rows: 1,500 rows of the widest staged table are about 1 MB on each surface. */
const PREVIEW_CAP = 1_500;
/** `row_limit` when omitted, unless the canvas row cap is lower. */
const ROW_LIMIT_DEFAULT = 1_000;

/** How the count inputs behave in one deployment. */
export interface DataframeQueryOptions {
  /** `UNHCR_CLAMP_LIMITS`: serve an over-cap count at its cap with a notice; `false` rejects it at the schema. */
  clamp: boolean;
  /** The canvas row cap (`CANVAS_DEFAULT_ROW_LIMIT`): `row_limit`'s cap, and its default when below 1,000. */
  rowLimitCap: number;
}

/** Build `unhcr_dataframe_query` for a clamp mode and canvas row cap. */
export function defineDataframeQueryTool({ clamp, rowLimitCap }: DataframeQueryOptions) {
  const rowLimitDefault = Math.min(ROW_LIMIT_DEFAULT, rowLimitCap);

  return tool(TOOL_NAME, {
    title: 'Query staged dataframes',
    description:
      'Run a single-statement SELECT against the dataframes staged by the unhcr_get_* tools. Check a dataframe’s columns with unhcr_dataframe_describe first. Writes, DDL, DROP, COPY, PRAGMA, ATTACH, file references, external-data functions, engine introspection, dynamic table lookup, and system catalogs are rejected; query() accepts only a single SQL string literal, checked by the same gate. Optional register_as saves the result as a new dataframe with a fresh TTL. Recompute rates from summed counts rather than averaging rate columns.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

    input: z.object({
      sql: z
        .string()
        .min(1)
        .max(
          SQL_MAX_LENGTH,
          `limited to ${SQL_CAP}; split the analysis into smaller queries, chaining them with register_as.`,
        )
        .describe(
          `One DuckDB SELECT against df_XXXXX_XXXXX tables, at most ${SQL_CAP} — joins, aggregates, window functions, and CTEs work. SUM and COUNT results come back as JSON strings (BIGINT); CAST(… AS DOUBLE) for inline arithmetic. Staged tables add origin/asylum UNHCR and UN region columns for regional GROUP BY.`,
        ),
      register_as: blankAsUnset(
        z.string().max(DATAFRAME_NAME_LENGTH).regex(DATAFRAME_NAME).optional(),
      ).describe(
        `Save the result as a new dataframe under this name (df_ plus two groups of 5 uppercase letters or digits, e.g. df_ABCDE_12345) with a fresh TTL, to chain analyses. The name must not already be staged. The saved rows count toward the ${STAGING_BUDGET} staging budget: the oldest other dataframes are evicted to make room, and a result larger than the budget is not saved.`,
      ),
      preview: blankAsUnset(countSchema(0, PREVIEW_CAP, clamp).optional()).describe(
        clamp
          ? `Rows returned inline; 0 returns only the columns and counts. Default ${PREVIEW_DEFAULT}; a larger value returns at most ${PREVIEW_CAP}, or row_limit when lower, and says so.`
          : `Rows returned inline; 0 returns only the columns and counts. 0–${PREVIEW_CAP} (default ${PREVIEW_DEFAULT}); a value above row_limit returns row_limit rows and says so.`,
      ),
      row_limit: blankAsUnset(countSchema(1, rowLimitCap, clamp).default(rowLimitDefault)).describe(
        clamp
          ? `Most rows the query materializes. Default ${rowLimitDefault}; a larger value materializes at most ${rowLimitCap} and says so. When more rows match, row_count_capped is true; use register_as to keep the full result.`
          : `Most rows the query materializes, 1–${rowLimitCap} (default ${rowLimitDefault}). When more rows match, row_count_capped is true; use register_as to keep the full result.`,
      ),
    }),

    output: z.object({
      complete: z
        .boolean()
        .describe(
          'False when any original source fetch was incomplete, independently of display truncation.',
        ),
      incomplete_sources: z
        .array(z.string())
        .describe(
          'Original incomplete upstream dataframe handles; retained through saved descendants.',
        ),
      columns: z.array(z.string()).describe('Column names in projection order.'),
      row_count: z
        .number()
        .int()
        .describe(
          'Rows the query produced, up to row_limit; with register_as, every row of the saved result. When row_count_capped is true this is the cap, not the full size.',
        ),
      row_count_capped: z
        .boolean()
        .describe('True when more rows matched than row_limit allowed through.'),
      rows: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          'The first preview rows of the result, one object per row keyed by column name. BIGINT values (SUM, COUNT) arrive as strings.',
        ),
      registered_as: z.string().optional().describe('The new dataframe, when register_as was set.'),
      expires_at: z
        .string()
        .optional()
        .describe('ISO 8601 expiry of the new dataframe, when register_as was set.'),
      evicted: z
        .array(z.string())
        .optional()
        .describe(
          `Older dataframes dropped, oldest first, to keep the staged total within the ${STAGING_BUDGET} budget once register_as saved this result; they can no longer be queried. Present only when any were evicted.`,
        ),
      attribution: attributionSchema,
    }),

    enrichment: {
      notice: z
        .string()
        .optional()
        .describe(
          'Guidance for this result: a clamped count, an incomplete source, an empty result, or rows withheld by preview or row_limit.',
        ),
      truncated: z.boolean().optional().describe('True when preview or row_limit withheld rows.'),
      shown: z.number().optional().describe('Rows returned inline.'),
      cap: z
        .number()
        .optional()
        .describe('The cap that bound: preview when lower than row_limit, otherwise row_limit.'),
    },

    errors: [
      {
        reason: 'canvas_unavailable',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: false,
        severity: 'warning',
        when: 'Dataframes are turned off in this deployment, or the SQL engine behind them could not load',
        recovery:
          "Dataframes are unavailable in this deployment, so retrying will not help; narrow the unhcr_get_* call's filters or year window so its rows fit inline.",
      },
      {
        reason: 'missing_table',
        code: JsonRpcErrorCode.NotFound,
        severity: 'notice',
        thrownBy: 'service',
        when: 'A df_<id> the SQL names is not staged: it never existed, its TTL expired, or it was evicted to make room for newer dataframes',
        recovery:
          'Check the name against the dataset.name or register_as that created it; if it expired or was evicted, re-run the unhcr_get_* call that produced it.',
      },
      {
        reason: 'invalid_sql',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'A statement starting with SELECT, WITH, or FROM does not parse, or the SELECT fails to prepare: an unknown column, table, or function, or an invalid expression',
        recovery:
          'Check SQL syntax, column names, and table names against unhcr_dataframe_describe.',
      },
      {
        reason: 'sql_execution_error',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The SELECT prepared but failed on the data it read: a cast or conversion that does not fit, an out-of-range value, or invalid input to a function',
        recovery:
          'Wrap the failing cast in TRY_CAST, or filter out the rows the error message names before converting them.',
      },
      {
        reason: 'register_as_clash',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The register_as name is already a staged dataframe',
        recovery: 'Choose a different df_XXXXX_XXXXX name for register_as, or omit register_as.',
      },
      {
        reason: 'register_as_too_large',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: `The register_as result alone holds more rows than the ${STAGING_BUDGET} staging budget, so it was not saved`,
        recovery:
          'Aggregate or filter so the result fits the staging budget, or omit register_as and read its first rows inline with preview.',
      },
      {
        reason: 'non_select_statement',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The statement is not a read-only SELECT: an INSERT, UPDATE, DDL, PRAGMA, or other write the engine refuses, or SQL that fails to parse and does not start with SELECT, WITH, or FROM (such as a misspelled SELEC)',
        recovery:
          'Send one read-only SELECT against the df_<id> tables your unhcr_get_* results or register_as calls created.',
      },
      {
        reason: 'multi_statement',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The SQL holds more than one statement',
        recovery:
          'Send exactly one SELECT statement per call, and split multi-statement SQL into separate calls.',
      },
      {
        reason: 'denied_function',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The SQL calls a denied external-data or introspection function, uses query_table, or passes query() anything other than a single SQL string literal',
        recovery:
          'Remove the denied function and reference your staged df_<id> tables directly; query() accepts only a single SQL string literal.',
      },
      {
        reason: 'plan_operator_not_allowed',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The query plan uses an operator outside the read-only allowlist, such as the range() or generate_series() table functions',
        recovery:
          'Rewrite with read-only SELECT constructs — joins, aggregates, window functions, CTEs, and unnest() are supported.',
      },
      {
        reason: 'system_catalog_access',
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
        thrownBy: 'service',
        when: 'The SQL references a system catalog (information_schema, pg_catalog, sqlite_master, duckdb_*)',
        recovery:
          'Query only the df_<id> tables your unhcr_get_* results or register_as calls created, by name.',
      },
    ],

    async handler(input, ctx) {
      const bridge = getCanvasBridge();
      if (!bridge?.available) {
        throw ctx.fail('canvas_unavailable', 'Dataframes are unavailable in this deployment.');
      }

      const rowLimit = clampCount(ctx, {
        tool: TOOL_NAME,
        field: 'row_limit',
        requested: input.row_limit,
        cap: rowLimitCap,
      });
      // Past row_limit no more rows exist to show, so preview's cap follows row_limit down.
      const preview: CountClamp =
        input.preview === undefined
          ? { effective: Math.min(PREVIEW_DEFAULT, rowLimit.effective) }
          : clampCount(ctx, {
              tool: TOOL_NAME,
              field: 'preview',
              requested: input.preview,
              cap: Math.min(PREVIEW_CAP, rowLimit.effective),
            });
      const { result, meta, providers, evicted, complete, incompleteSources } = await bridge.query(
        ctx,
        input.sql,
        {
          rowLimit: rowLimit.effective,
          ...(input.register_as !== undefined && { registerAs: input.register_as }),
        },
      );

      const output: QueryOutput = {
        columns: result.columns,
        row_count: result.rowCount,
        row_count_capped: result.truncated === true,
        rows: result.rows.slice(0, preview.effective),
        complete,
        incomplete_sources: incompleteSources,
        ...(meta && { registered_as: meta.tableName, expires_at: meta.expiresAt }),
        ...(evicted && { evicted }),
        attribution: buildAttribution(providers),
      };

      const shown = output.rows.length;
      const previewBinds = preview.effective < rowLimit.effective;
      const cap = previewBinds ? preview.effective : rowLimit.effective;
      /**
       * The count that withheld rows, offered only while it is below its own
       * ceiling: row_limit when the result is capped (no preview reaches past
       * it), otherwise preview, which this call serves up to 1,500 or row_limit.
       * At a ceiling the rest is reached by paging the SELECT.
       */
      const previewCeiling = Math.min(PREVIEW_CAP, rowLimit.effective);
      const lever = output.row_count_capped
        ? rowLimit.effective < rowLimitCap && `raise row_limit (max ${rowLimitCap})`
        : preview.effective < previewCeiling && `raise preview (max ${previewCeiling})`;
      const rest = `Use register_as to keep the whole result, or ${lever || 'page through it with LIMIT and OFFSET'}.`;
      const fragments = [rowLimit.notice, preview.notice].filter((notice) => notice !== undefined);
      if (!complete)
        fragments.push(
          `This result is partial: upstream fetches for ${incompleteSources.join(', ')} stopped before completion. Narrow the original data calls to obtain complete sources.`,
        );
      if (result.rowCount === 0) {
        fragments.push(
          'Query returned 0 rows. Check the dataframe names and columns with unhcr_dataframe_describe, and whether the filters or joins in the query exclude every row.',
        );
      } else if (output.row_count_capped) {
        fragments.push(
          `Showing ${shown} rows. More than row_limit (${rowLimit.effective}) matched, so row_count is the cap, not the full size. ${rest}`,
        );
      } else if (result.rowCount > shown) {
        fragments.push(
          meta
            ? `Showing ${shown} of ${result.rowCount} rows; the full result is saved as ${meta.tableName}, so query it for the rest.`
            : `Showing ${shown} of ${result.rowCount} rows. ${rest}`,
        );
      }

      const notice = fragments.join(' ');
      if (output.row_count_capped || shown < result.rowCount)
        ctx.enrich.truncated({ shown, cap, ...(notice && { guidance: notice }) });
      else if (notice) ctx.enrich.notice(notice);
      return output;
    },

    format: formatQueryOutput,
  });
}

/** The default-mode definition at the framework's default canvas row cap, which `lint:mcp` reads. */
export const dataframeQueryTool = defineDataframeQueryTool({
  clamp: true,
  rowLimitCap: ConfigSchema.shape.canvas.shape.defaultRowLimit.parse(undefined),
});
