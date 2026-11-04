/**
 * @fileoverview Lossless `content[]` rendering of unhcr_dataframe_query results:
 * a Markdown table when every label and cell is plain, fenced JSON otherwise.
 * @module mcp-server/tools/shared/query-output
 */

import { fence, table } from './markdown.js';
import { type Attribution, renderAttribution, renderEvicted } from './outputs.js';

/** Domain payload of unhcr_dataframe_query, before framework enrichment. */
export interface QueryOutput {
  attribution: Attribution;
  columns: string[];
  complete: boolean;
  evicted?: string[];
  expires_at?: string;
  incomplete_sources: string[];
  registered_as?: string;
  row_count: number;
  row_count_capped: boolean;
  rows: Record<string, unknown>[];
}

/** Query cells with Markdown or control syntax use fenced JSON, preserving exact values and labels. */
export function formatQueryOutput(result: QueryOutput): { type: 'text'; text: string }[] {
  const lines: string[] = [];
  if (result.registered_as)
    lines.push(
      `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'with its TTL'}).`,
    );
  if (result.evicted) lines.push(renderEvicted(result.evicted));
  const shown = result.rows.length < result.row_count ? `, showing ${result.rows.length}` : '';
  lines.push(
    `**${result.row_count} rows**${result.row_count_capped ? ` — capped at row_limit${shown}; more rows matched` : shown}`,
    '',
  );
  lines.push(
    `Complete: ${result.complete}. Incomplete sources: ${result.incomplete_sources.length ? result.incomplete_sources.join(', ') : 'none'}.`,
  );
  const simple = (value: unknown): boolean =>
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' &&
      value.trim() === value &&
      !value.includes('  ') &&
      /^[a-z0-9 .,/:;()=+-]*$/i.test(value));
  if (
    !result.columns.every(simple) ||
    result.rows.some((row) => result.columns.some((column) => !simple(row[column])))
  ) {
    lines.push(fence(JSON.stringify({ columns: result.columns, rows: result.rows }), 'json'));
  } else if (result.rows.length === 0) {
    lines.push('_No rows._');
    if (result.columns.length) lines.push(`Columns: ${result.columns.join(', ')}`);
  } else {
    lines.push(
      table(
        result.columns,
        result.rows.map((row) => result.columns.map((column) => String(row[column]))),
      ),
    );
  }
  lines.push('', renderAttribution(result.attribution));
  return [{ type: 'text', text: lines.join('\n') }];
}
