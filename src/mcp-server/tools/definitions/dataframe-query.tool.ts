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
import { attributionSchema, STAGING_BUDGET } from '../shared/outputs.js';
import {
  formatQueryOutput,
  QUERY_RESULT_MAX_BYTES,
  type QueryDisclosure,
  type QueryOutput,
  queryResultBytes,
} from '../shared/query-output.js';
import { buildAttribution } from '../shared/results.js';

/** Longest `sql` accepted: DuckDB's parse cost grows with statement length, and the cap bounds it. */
const SQL_MAX_LENGTH = 20_000;
const SQL_CAP = `${SQL_MAX_LENGTH.toLocaleString('en-US')} characters`;

export const dataframeQueryTool = tool('unhcr_dataframe_query', {
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
    preview: blankAsUnset(z.number().int().min(0).max(1_000_000).optional()).describe(
      'Requested inline rows, 0–1000000. Values above row_limit are clamped to row_limit with disclosure. Omit to return every row up to row_limit; the serialized byte ceiling may withhold whole rows or metadata, preserving the result as lossless chunks.',
    ),
    row_limit: blankAsUnset(z.number().int().min(1).max(10_000).default(1000)).describe(
      'Most rows the query materializes (1–10000, default 1000). When more match, row_count_capped is true; use register_as to keep the full result.',
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
        'Original incomplete upstream dataframe handles; retained through saved descendants. If metadata_withheld is true, consult the result snapshot for the full list.',
      ),
    metadata_withheld: z
      .boolean()
      .optional()
      .describe(
        'True when oversized column names or incomplete-source metadata are withheld inline and retained in result_chunks.',
      ),
    result_chunks: z
      .object({
        name: z
          .string()
          .describe('Tenant-scoped dataframe holding chunk_index and base64 chunk columns.'),
        encoding: z
          .literal('base64-json-utf8')
          .describe(
            'Decode each base64 chunk, concatenate bytes in index order, then decode UTF-8 and JSON.',
          ),
        chunk_count: z
          .number()
          .int()
          .describe('Chunks numbered from zero, with at most 6144 source bytes each.'),
        expires_at: z.string().describe('ISO 8601 expiry of the chunk dataframe.'),
      })
      .optional()
      .describe(
        'Lossless materialized result snapshot when the byte ceiling withholds rows or metadata.',
      ),
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
      reason: 'result_storage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      severity: 'warning',
      thrownBy: 'service',
      when: 'The lossless result snapshot cannot be retained within the staging budget or storage fails',
      recovery:
        'Select fewer columns or smaller values, or filter or aggregate the query, so its result fits inline or in the staging budget.',
    },
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

    // The canvas refuses a preview above rowLimit; past row_limit no more rows exist to show.
    const preview =
      input.preview === undefined ? undefined : Math.min(input.preview, input.row_limit);
    const { result, meta, providers, evicted, complete, incompleteSources, chunkSource } =
      await bridge.query(ctx, input.sql, {
        rowLimit: input.row_limit,
        ...(input.register_as !== undefined && { registerAs: input.register_as }),
      });

    const capped = result.truncated === true;
    const previewBinds = preview !== undefined && preview < input.row_limit;
    const cap = previewBinds ? preview : input.row_limit;
    const lever = previewBinds ? 'raise preview' : 'raise row_limit (max 10000)';
    const snapshot: QueryOutput = {
      columns: result.columns,
      row_count: result.rowCount,
      row_count_capped: capped,
      rows: result.rows,
      complete,
      incomplete_sources: incompleteSources,
      ...(meta && { registered_as: meta.tableName, expires_at: meta.expiresAt }),
      ...(evicted && { evicted }),
      attribution: buildAttribution(providers),
    };
    const output: QueryOutput = {
      ...snapshot,
      rows: result.rows.slice(0, preview ?? input.row_limit),
    };
    let byteWithheld = false;
    const disclosure = (): QueryDisclosure => {
      const fragments: string[] = [];
      if (input.preview !== undefined && input.preview > (preview ?? input.row_limit)) {
        fragments.push(`Requested preview ${input.preview}; effective preview ${preview}.`);
      }
      if (!complete)
        fragments.push(
          `This result is partial: upstream fetches for ${output.incomplete_sources.length ? output.incomplete_sources.join(', ') : 'the sources retained in the result snapshot'} stopped before completion. Narrow the original data calls to obtain complete sources.`,
        );
      if (result.rowCount === 0) {
        fragments.push(
          'Query returned 0 rows. Check the dataframe names and columns with unhcr_dataframe_describe, and whether the filters or joins in the query exclude every row.',
        );
      } else if (capped) {
        fragments.push(
          `Showing ${output.rows.length} rows. More than row_limit (${input.row_limit}) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or ${lever}.`,
        );
      } else if (result.rowCount > output.rows.length) {
        fragments.push(
          meta
            ? `Showing ${output.rows.length} of ${result.rowCount} rows; the full result is saved as ${meta.tableName}, so query it for the rest.`
            : byteWithheld
              ? `Showing ${output.rows.length} of ${result.rowCount} rows.`
              : `Showing ${output.rows.length} of ${result.rowCount} rows. Use register_as to keep the whole result, or ${lever}.`,
        );
      }
      if (byteWithheld)
        fragments.push(
          `The serialized result is limited to ${QUERY_RESULT_MAX_BYTES} UTF-8 bytes; whole rows or oversized metadata were withheld.`,
        );
      if (output.result_chunks)
        fragments.push(
          `Read SELECT chunk_index,chunk FROM ${output.result_chunks.name} WHERE chunk_index=0 with unhcr_dataframe_query, then increment chunk_index through ${output.result_chunks.chunk_count - 1}. Base64-decode each chunk separately, concatenate bytes in index order, then decode UTF-8 and parse JSON.`,
        );
      const notice = fragments.join(' ');
      const truncated = capped || output.rows.length < result.rowCount || byteWithheld;
      return {
        ...(truncated && { truncated: true, shown: output.rows.length, cap }),
        ...(notice && { notice }),
      };
    };

    if (queryResultBytes(output, disclosure()) > QUERY_RESULT_MAX_BYTES) {
      byteWithheld = true;
      // A page of unmodified chunks already has its canonical snapshot. Never spill the spill.
      const chunkPage =
        chunkSource &&
        new RegExp(
          `^\\s*SELECT\\s+(?:chunk_index\\s*,\\s*chunk|\\*)\\s+FROM\\s+"?${chunkSource.tableName}"?(?=\\s|;|$)`,
          'i',
        ).test(input.sql) &&
        !/\b(?:join|union|intersect|except|group|having)\b/i.test(input.sql) &&
        result.columns.length === 2 &&
        result.columns[0] === 'chunk_index' &&
        result.columns[1] === 'chunk' &&
        result.rows.every(
          (row) =>
            typeof row.chunk === 'string' &&
            row.chunk.length <= 8192 &&
            Number.isInteger(Number(row.chunk_index)),
        );
      const chunks = chunkPage
        ? {
            name: chunkSource.tableName,
            row_count: chunkSource.rowCount,
            expires_at: chunkSource.expiresAt,
          }
        : await bridge.stageResultChunks(
            ctx,
            snapshot,
            { complete, incompleteSources, providers },
            [...(meta ? [meta.tableName] : []), ...(chunkSource ? [chunkSource.tableName] : [])],
          );
      output.result_chunks = {
        name: chunks.name,
        encoding: 'base64-json-utf8',
        chunk_count: chunks.row_count,
        expires_at: chunks.expires_at,
      };
      if ('evicted' in chunks && chunks.evicted)
        output.evicted = [...(output.evicted ?? []), ...chunks.evicted];
      const originalRows = output.rows;
      output.rows = [];
      if (queryResultBytes(output, disclosure()) > QUERY_RESULT_MAX_BYTES) {
        output.columns = [];
        output.incomplete_sources = [];
        output.metadata_withheld = true;
      }
      // Binary search keeps complete rows and avoids serializing every prefix of a large page.
      let low = 0;
      let high = output.metadata_withheld ? 0 : originalRows.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        output.rows = originalRows.slice(0, middle);
        if (queryResultBytes(output, disclosure()) <= QUERY_RESULT_MAX_BYTES) low = middle;
        else high = middle - 1;
      }
      output.rows = originalRows.slice(0, low);
      if (queryResultBytes(output, disclosure()) > QUERY_RESULT_MAX_BYTES)
        throw ctx.fail(
          'result_storage_unavailable',
          'Bounded SQL result metadata exceeded its byte budget.',
        );
    }
    const enriched = disclosure();
    if (enriched.truncated)
      ctx.enrich.truncated({
        shown: output.rows.length,
        cap,
        ...(enriched.notice && { guidance: enriched.notice }),
      });
    else if (enriched.notice) ctx.enrich.notice(enriched.notice);
    return output;
  },

  format: formatQueryOutput,
});
