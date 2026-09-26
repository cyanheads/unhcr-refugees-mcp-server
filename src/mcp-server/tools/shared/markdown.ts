/**
 * @fileoverview Markdown helpers for `format()`. Upstream text (country and
 * region names, footnotes, nowcast source labels) and echoed caller input are
 * data: inline slots flatten every line break to a space, table cells also
 * escape `\` and `|`, multi-line text is blockquoted, and caller-supplied blobs
 * are fenced with a fence longer than any backtick run inside them. A line
 * break is CR, LF, or CRLF, and also VT, FF, the FS/GS/RS separators, NEL,
 * U+2028, and U+2029, which some renderers and line splitters treat as one.
 * `structuredContent` keeps every value verbatim; only the markdown twin is
 * shaped here.
 * @module mcp-server/tools/shared/markdown
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: FS, GS, RS, and NEL are line separators this must match.
const LINE_BREAK = /\r\n|[\n\v\f\r\u{1c}-\u{1e}\u{85}\u{2028}\u{2029}]/gu;

/** Flatten line breaks to single spaces for an inline slot. */
export function inline(text: string): string {
  return text.replace(LINE_BREAK, ' ');
}

/** Escape text for one markdown table cell. */
export function cell(text: string): string {
  return inline(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Blockquote text line by line, so multi-line upstream text stays one block. */
export function blockquote(text: string): string {
  return text
    .split(LINE_BREAK)
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
