/**
 * @fileoverview unhcr_dataframe_query — one read-only SELECT across the
 * dataframes the unhcr_get_* tools staged. The framework's SQL gate enforces a
 * single SELECT with an allowlisted plan and no file-reading functions; this
 * tool also denies system catalogs, so a caller sees only the tables it holds
 * a handle to. Results carry the attribution UNHCR's terms require, crediting
 * the third-party series recorded for every dataframe the SQL references. A
 * register_as result counts toward the tenant's staging budget and names any
 * dataframes it evicted.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DATAFRAME_NAME,
  DATAFRAME_NAME_LENGTH,
  getCanvasBridge,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { blankAsUnset } from '../shared/inputs.js';
import { cell, inline, table } from '../shared/markdown.js';
import {
  attributionSchema,
  renderAttribution,
  renderEvicted,
  STAGING_BUDGET,
} from '../shared/outputs.js';
import { buildAttribution } from '../shared/results.js';

/** Longest `sql` accepted: DuckDB's parse cost grows with statement length, and the cap bounds it. */
const SQL_MAX_LENGTH = 20_000;
const SQL_CAP = `${SQL_MAX_LENGTH.toLocaleString('en-US')} characters`;

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return cell(value);
  if (typeof value === 'object') return cell(JSON.stringify(value));
  return String(value);
};

export const dataframeQueryTool = tool('unhcr_dataframe_query', {
  title: 'Query staged dataframes',
  description:
    'Run a single-statement SELECT against the dataframes staged by the unhcr_get_* tools. Check a dataframe’s columns with unhcr_dataframe_describe first. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, external-file functions, and system catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are rejected. Optional register_as saves the result as a new dataframe with a fresh TTL. Recompute rates from summed counts rather than averaging rate columns.',
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
    preview: blankAsUnset(z.number().int().min(0).max(10_000).optional()).describe(
      'Rows to return inline when that should be fewer than the query materializes, e.g. a small sample while register_as keeps the whole result; a value above row_limit is treated as row_limit. Omit to return every row up to row_limit.',
    ),
    row_limit: blankAsUnset(z.number().int().min(1).max(10_000).default(1000)).describe(
      'Most rows the query materializes (1–10000, default 1000). When more match, row_count_capped is true; use register_as to keep the full result.',
    ),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .int()
      .describe(
        'Rows the query produced, up to row_limit. When row_count_capped is true this is the cap, not the full size.',
      ),
    row_count_capped: z
      .boolean()
      .describe('True when more rows matched than row_limit allowed through.'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows, one object per row keyed by column name, bounded by preview and row_limit. BIGINT values (SUM, COUNT) arrive as strings.',
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
      .describe('Guidance when the query returned no rows or rows were withheld.'),
    truncated: z.boolean().optional().describe('True when rows were withheld by a cap.'),
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
      recovery: 'Check SQL syntax, column names, and table names against unhcr_dataframe_describe.',
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
        'Aggregate or filter so the result fits the staging budget, or omit register_as and read up to row_limit rows inline.',
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
      when: 'The SQL calls a file-reading or external-data table function such as read_csv, read_parquet, or glob',
      recovery:
        'Remove the file-reading function and query only the df_<id> tables your unhcr_get_* results or register_as calls created.',
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

    // The canvas refuses a preview above rowLimit; past row_limit no more rows exist to show.
    const preview =
      input.preview === undefined ? undefined : Math.min(input.preview, input.row_limit);
    const { result, meta, providers, evicted } = await bridge.query(ctx, input.sql, {
      rowLimit: input.row_limit,
      ...(preview !== undefined && { preview }),
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
    });

    const capped = result.truncated === true;
    const previewBinds = preview !== undefined && preview < input.row_limit;
    const cap = previewBinds ? preview : input.row_limit;
    const lever = previewBinds ? 'raise preview' : 'raise row_limit (max 10000)';
    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'Query returned 0 rows. Check the dataframe names and columns with unhcr_dataframe_describe, and whether the filters or joins in the query exclude every row.',
      );
    } else if (capped) {
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap,
        guidance: `Showing ${result.rows.length} rows. More than row_limit (${input.row_limit}) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or ${lever}.`,
      });
    } else if (result.rowCount > result.rows.length) {
      // Re-running under the same register_as name would clash, so name the saved table instead.
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap,
        guidance: meta
          ? `Showing ${result.rows.length} of ${result.rowCount} rows; the full result is saved as ${meta.tableName}, so query it for the rest.`
          : `Showing ${result.rows.length} of ${result.rowCount} rows. Use register_as to keep the whole result, or ${lever}.`,
      });
    }

    return {
      columns: result.columns,
      row_count: result.rowCount,
      row_count_capped: capped,
      rows: result.rows,
      ...(meta && { registered_as: meta.tableName, expires_at: meta.expiresAt }),
      ...(evicted && { evicted }),
      attribution: buildAttribution(providers),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(
        `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'with its TTL'}).`,
      );
    }
    if (result.evicted) lines.push(renderEvicted(result.evicted));
    const shown = result.rows.length < result.row_count ? `, showing ${result.rows.length}` : '';
    lines.push(
      `**${result.row_count} rows**${result.row_count_capped ? ` — capped at row_limit${shown}; more rows matched` : shown}`,
      '',
    );
    if (result.rows.length === 0) {
      lines.push('_No rows._');
      if (result.columns.length > 0)
        lines.push(`Columns: ${result.columns.map(inline).join(', ')}`);
    } else {
      lines.push(
        table(
          result.columns.map(cell),
          result.rows.map((row) => result.columns.map((column) => renderValue(row[column]))),
        ),
      );
    }
    lines.push('', renderAttribution(result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
