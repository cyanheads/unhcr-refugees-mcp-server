/**
 * @fileoverview unhcr_dataframe_describe — describes the `df_<id>` dataframes
 * the unhcr_get_* tools staged, with provenance, expiry, completeness, the
 * third-party series they carry, and their column schema. Expired entries are
 * swept first. Where the deployment turns listing off (HTTP without
 * authentication, where every caller shares one tenant), a call without `name`
 * fails `listing_unavailable` and only lookups by exact name answer.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DATAFRAME_NAME,
  DATAFRAME_NAME_LENGTH,
  getCanvasBridge,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { blankAsUnset } from '../shared/inputs.js';
import { fence, inline } from '../shared/markdown.js';

export const dataframeDescribeTool = tool('unhcr_dataframe_describe', {
  title: 'Describe staged dataframes',
  description:
    'Describe a dataframe (df_XXXXX_XXXXX) staged by the unhcr_get_* tools — any response carrying a dataset handle staged its full result here — or list them all where this deployment allows listing. Each entry gives the source tool, query parameters, creation and expiry time, row count, whether the upstream fetch was complete, and the column schema. Read the columns here before writing SQL for unhcr_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: blankAsUnset(
      z.string().max(DATAFRAME_NAME_LENGTH).regex(DATAFRAME_NAME).optional(),
    ).describe(
      'One dataframe to describe, as df_XXXXX_XXXXX (uppercase letters and digits): the dataset.name a unhcr_get_* result returned, or a register_as name. Omit to list every staged dataframe; a deployment that serves unauthenticated callers over HTTP turns listing off, and there the name is required.',
    ),
  }),

  output: z.object({
    dataframes: z
      .array(
        z
          .object({
            name: z.string().describe('Dataframe name (df_XXXXX_XXXXX) to use in SQL.'),
            source_tool: z
              .string()
              .describe(
                'Tool that staged it: a unhcr_get_* tool, or unhcr_dataframe_query for a register_as result.',
              ),
            query_params: z
              .record(z.string(), z.unknown())
              .describe(
                'Arguments the source tool was called with, keyed by input name; { sql } for a register_as result.',
              ),
            created_at: z.string().describe('ISO 8601 time it was staged.'),
            expires_at: z.string().describe('ISO 8601 time it expires.'),
            row_count: z.number().int().describe('Rows in the dataframe.'),
            complete: z
              .boolean()
              .describe(
                'False when the server row cap stopped the upstream fetch that produced it.',
              ),
            providers: z
              .array(z.string())
              .describe('Third-party series the rows carry (IDMC, UNRWA), for attribution.'),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z
                      .string()
                      .describe('Column type (INTEGER, DOUBLE, VARCHAR, BOOLEAN, …).'),
                    nullable: z.boolean().describe('Whether the column may hold NULL.'),
                  })
                  .describe('One column.'),
              )
              .describe('Columns in table order.'),
          })
          .describe('One staged dataframe.'),
      )
      .describe('Staged dataframes, newest first. Empty when none are staged.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing is staged or the named dataframe is gone.'),
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
      reason: 'listing_unavailable',
      code: JsonRpcErrorCode.Forbidden,
      severity: 'notice',
      when: "name was omitted on a deployment that serves unauthenticated callers over HTTP, where a listing would show other callers' dataframes",
      recovery:
        'Pass the exact dataframe name: the dataset.name a unhcr_get_* result returned, or your register_as name.',
    },
  ],

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge?.available) {
      throw ctx.fail(
        'canvas_unavailable',
        'Dataframes are unavailable in this deployment.',
        ctx.recoveryFor('canvas_unavailable'),
      );
    }
    if (input.name === undefined && !bridge.listingEnabled) {
      throw ctx.fail(
        'listing_unavailable',
        'Listing every staged dataframe is turned off in this deployment; describe one by name.',
        ctx.recoveryFor('listing_unavailable'),
      );
    }

    const entries = await bridge.describe(ctx, input.name);
    if (entries.length === 0) {
      const next = bridge.listingEnabled
        ? 'Call unhcr_dataframe_describe without name to list what is staged, or re-run'
        : 'Re-run';
      ctx.enrich.notice(
        input.name
          ? `No dataframe named ${input.name}; it may have expired or been evicted to make room for newer dataframes. ${next} the unhcr_get_* call that produced it.`
          : 'No dataframes are staged. A unhcr_get_* call stages its full result when it exceeds limit or when stage is true.',
      );
    }
    return {
      dataframes: entries.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        complete: meta.complete,
        providers: meta.providers,
        column_schema: meta.columnSchema.map((column) => ({
          name: column.name,
          type: column.type,
          nullable: column.nullable ?? true,
        })),
      })),
    };
  },

  format: (result) => {
    if (result.dataframes.length === 0) return [{ type: 'text', text: '_No staged dataframes._' }];
    const lines = [`**${result.dataframes.length} staged dataframe(s)**`, ''];
    for (const df of result.dataframes) {
      lines.push(
        `### ${df.name}`,
        `- **Source:** ${df.source_tool}`,
        `- **Rows:** ${df.row_count} · **Complete:** ${df.complete ? 'yes' : 'no — the row cap stopped the fetch'}`,
        `- **Created:** ${df.created_at} · **Expires:** ${df.expires_at}`,
        `- **Providers:** ${df.providers.length ? df.providers.join(', ') : 'UNHCR only'}`,
        `- **Columns:** ${df.column_schema.map((column) => `${inline(column.name)} ${inline(column.type)} ${column.nullable ? 'nullable' : 'NOT NULL'}`).join(', ')}`,
        '- **Query params:**',
        '',
        fence(JSON.stringify(df.query_params, null, 2), 'json'),
        '',
      );
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
