/**
 * @fileoverview Parse UNHCR's footnotes and match them to result rows locally.
 * A footnote attaches when its population types overlap the tool's types, its
 * year spec covers the row year, and every country it names (by ISO3, never by
 * display name) equals that row's country. A footnote naming a country never
 * attaches to a row where that dimension is summed; one naming no country
 * attaches everywhere. Only footnotes matching at least one row are returned.
 * @module services/unhcr/footnote-match
 */

import type { RawRow } from './types.js';

/** A parsed footnote. */
export interface Footnote {
  asylumIso3: string | null;
  originIso3: string | null;
  populationTypes: string[];
  /** Inclusive year ranges parsed from `years`. */
  ranges: [number, number][];
  text: string;
  /** Upstream year spec, verbatim (`"2015"`, `"2019 - 2022"`, `"2021, 2023 - 2025"`). */
  years: string;
}

/** A footnote matched against a result, in output shape. */
export interface MatchedFootnote {
  asylum_iso3: string | null;
  origin_iso3: string | null;
  population_types: string[];
  rows_matched: number;
  text: string;
  years: string;
}

/** The row coordinates footnote matching reads. */
export interface FootnoteRowKey {
  asylum_iso3: string | null;
  origin_iso3: string | null;
  year: number;
}

/** Most footnotes one response carries; the total is reported separately. */
export const FOOTNOTE_CAP = 20;

/** Parse a year spec into inclusive ranges. Unparseable segments are dropped. */
export function parseYearSpec(spec: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const segment of spec.split(',')) {
    const match = segment.trim().match(/^(\d{4})(?:\s*[-–]\s*(\d{4}))?$/);
    if (!match?.[1]) continue;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    ranges.push(from <= to ? [from, to] : [to, from]);
  }
  return ranges;
}

/** Parse a comma-separated population-type list into uppercase codes. */
export function parsePopulationTypes(spec: string): string[] {
  return spec
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '');
}

const isoOrNull = (value: unknown): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
};

/** Parse one upstream footnote row. */
export function toFootnote(raw: RawRow): Footnote {
  const years = typeof raw.year === 'string' ? raw.year.trim() : String(raw.year ?? '');
  return {
    text: typeof raw.footnote === 'string' ? raw.footnote.trim() : '',
    years,
    ranges: parseYearSpec(years),
    originIso3: isoOrNull(raw.coo_iso),
    asylumIso3: isoOrNull(raw.coa_iso),
    populationTypes: parsePopulationTypes(
      typeof raw.population_type === 'string' ? raw.population_type : '',
    ),
  };
}

/** Earliest and latest year any footnote covers, or `undefined` for an empty set. */
export function footnoteSpan(footnotes: readonly Footnote[]): [number, number] | undefined {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const note of footnotes) {
    for (const [from, to] of note.ranges) {
      first = Math.min(first, from);
      last = Math.max(last, to);
    }
  }
  return Number.isFinite(first) ? [first, last] : undefined;
}

const coverageKey = (origin: string | null, asylum: string | null): string =>
  `${origin ?? ''}|${asylum ?? ''}`;

/** Row counts per year under each key a footnote can name. */
function indexRows(rows: readonly FootnoteRowKey[]): Map<string, Map<number, number>> {
  const index = new Map<string, Map<number, number>>();
  const bump = (key: string, year: number) => {
    let years = index.get(key);
    if (!years) {
      years = new Map();
      index.set(key, years);
    }
    years.set(year, (years.get(year) ?? 0) + 1);
  };
  for (const row of rows) {
    bump(coverageKey(null, null), row.year);
    if (row.origin_iso3) bump(coverageKey(row.origin_iso3, null), row.year);
    if (row.asylum_iso3) bump(coverageKey(null, row.asylum_iso3), row.year);
    if (row.origin_iso3 && row.asylum_iso3) {
      bump(coverageKey(row.origin_iso3, row.asylum_iso3), row.year);
    }
  }
  return index;
}

/**
 * Match footnotes to a full result. Country-specific footnotes come first, then
 * the ones naming no country, each group in UNHCR's order; the list is capped
 * at {@link FOOTNOTE_CAP} and `total` counts every match.
 */
export function matchFootnotes(
  footnotes: readonly Footnote[],
  rows: readonly FootnoteRowKey[],
  toolTypes: readonly string[],
): { footnotes: MatchedFootnote[]; total: number } {
  if (rows.length === 0) return { footnotes: [], total: 0 };
  const types = new Set(toolTypes);
  const index = indexRows(rows);
  const specific: MatchedFootnote[] = [];
  const general: MatchedFootnote[] = [];

  for (const note of footnotes) {
    if (!note.populationTypes.some((type) => types.has(type))) continue;
    const years = index.get(coverageKey(note.originIso3, note.asylumIso3));
    if (!years) continue;
    let matched = 0;
    for (const [year, count] of years) {
      if (note.ranges.some(([from, to]) => year >= from && year <= to)) matched += count;
    }
    if (matched === 0) continue;
    const entry: MatchedFootnote = {
      text: note.text,
      years: note.years,
      origin_iso3: note.originIso3,
      asylum_iso3: note.asylumIso3,
      population_types: note.populationTypes,
      rows_matched: matched,
    };
    (note.originIso3 || note.asylumIso3 ? specific : general).push(entry);
  }

  const all = [...specific, ...general];
  return { footnotes: all.slice(0, FOOTNOTE_CAP), total: all.length };
}
