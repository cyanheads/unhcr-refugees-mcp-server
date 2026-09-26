/**
 * @fileoverview Markdown helpers for `format()`. Upstream text (country and
 * region names, footnotes, nowcast source labels) and echoed caller input are
 * data: inline slots flatten CR/LF to a space, table cells also escape `\` and
 * `|`, multi-line text is blockquoted, and caller-supplied blobs are fenced
 * with a fence longer than any backtick run inside them. `structuredContent`
 * keeps every value verbatim; only the markdown twin is shaped here.
 * @module mcp-server/tools/shared/markdown
 */

/** Flatten line breaks to single spaces for an inline slot. */
export function inline(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

/** Escape text for one markdown table cell. */
export function cell(text: string): string {
  return inline(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Blockquote text line by line, so multi-line upstream text stays one block. */
export function blockquote(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** Fence a block with more backticks than any run it contains. */
export function fence(text: string, info = ''): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${ticks}${info}\n${text}\n${ticks}`;
}

/** Render a count with digit grouping; `null` (not applicable or not collected) as an em dash. */
export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US');
}

/** Render one markdown table from a header row and string cells. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}
