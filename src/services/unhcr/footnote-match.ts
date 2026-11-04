/**
 * @fileoverview Parse UNHCR's footnotes and match them to result rows locally.
 * A footnote attaches to a row when the row carries one of its population
 * types, its year spec covers the row year, and every country it names (by
 * ISO3, never by display name) equals that row's country. A footnote naming a
 * country never attaches to a row where that dimension is summed; one naming
 * no country attaches everywhere. Only footnotes matching at least one row are
 * returned, ranked against the result's inline cut so the cap drops the
 * caveats furthest from the rows shown.
 * @module services/unhcr/footnote-match
 */

import { FOLDED_TYPES, POPULATION_TYPES } from './codes.js';
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

/** A population type plus the type counted inside it: REF carries ROC, IDP carries IOC. */
export function withFolded(code: string | null): string[] {
  if (!code) return [];
  const folded = FOLDED_TYPES.get(code);
  return folded ? [code, folded] : [code];
}

/** The footnote types each count column carries, keyed by output column. */
const COLUMN_TYPES = new Map(
  POPULATION_TYPES.flatMap(({ code, field }): [string, string[]][] =>
    field ? [[field, withFolded(code)]] : [],
  ),
);

/**
 * The footnote types a population or solutions row carries: those of each
 * count column above zero, plus the types folded into them. A column that is
 * zero or null carries none, and columns no population type maps to are
 * ignored.
 */
export function typesWithCounts(row: object): string[] {
  return Object.entries(row).flatMap(([field, value]) =>
    typeof value === 'number' && value > 0 ? (COLUMN_TYPES.get(field) ?? []) : [],
  );
}

const coverageKey = (origin: string | null, asylum: string | null): string =>
  `${origin ?? ''}|${asylum ?? ''}`;

/** One row as the index holds it: its position in the sorted result and its footnote types. */
interface IndexedRow {
  position: number;
  types: readonly string[];
}

/**
 * Each row's position and footnote types, per year, under each key a footnote
 * can name. Rows are added in result order, so each list ascends by position.
 */
function indexRows<R extends FootnoteRowKey>(
  rows: readonly R[],
  typesOf: (row: R) => readonly string[],
): Map<string, Map<number, IndexedRow[]>> {
  const index = new Map<string, Map<number, IndexedRow[]>>();
  const add = (key: string, year: number, entry: IndexedRow) => {
    let years = index.get(key);
    if (!years) {
      years = new Map();
      index.set(key, years);
    }
    const perYear = years.get(year);
    if (perYear) perYear.push(entry);
    else years.set(year, [entry]);
  };
  rows.forEach((row, position) => {
    const types = typesOf(row);
    if (types.length === 0) return;
    const entry = { position, types };
    add(coverageKey(null, null), row.year, entry);
    if (row.origin_iso3) add(coverageKey(row.origin_iso3, null), row.year, entry);
    if (row.asylum_iso3) add(coverageKey(null, row.asylum_iso3), row.year, entry);
    if (row.origin_iso3 && row.asylum_iso3) {
      add(coverageKey(row.origin_iso3, row.asylum_iso3), row.year, entry);
    }
  });
  return index;
}

/**
 * Match footnotes to a full result in its sorted order, whose first `inline`
 * rows are the ones shown inline (the effective `limit`). `typesOf` names the
 * population types each row carries; a footnote counts only rows carrying one
 * of its types. The list is ranked so the cap at {@link FOOTNOTE_CAP} drops
 * the caveats furthest from the inline rows: those matching an inline row come
 * before those matching only rows past the cut; within each group,
 * country-specific before naming no country, then by the first row matched,
 * then UNHCR's order. `total` and each `rows_matched` count the full result.
 */
export function matchFootnotes<R extends FootnoteRowKey>(
  footnotes: readonly Footnote[],
  rows: readonly R[],
  typesOf: (row: R) => readonly string[],
  inline: number,
): { footnotes: MatchedFootnote[]; total: number } {
  if (rows.length === 0) return { footnotes: [], total: 0 };
  const index = indexRows(rows, typesOf);
  const ranked: { entry: MatchedFootnote; first: number; general: boolean }[] = [];

  for (const note of footnotes) {
    const years = index.get(coverageKey(note.originIso3, note.asylumIso3));
    if (!years) continue;
    const noteTypes = new Set(note.populationTypes);
    let matched = 0;
    let first = Number.POSITIVE_INFINITY;
    for (const [year, entries] of years) {
      if (!note.ranges.some(([from, to]) => year >= from && year <= to)) continue;
      for (const { position, types } of entries) {
        if (!types.some((type) => noteTypes.has(type))) continue;
        matched++;
        first = Math.min(first, position);
      }
    }
    if (matched === 0) continue;
    ranked.push({
      entry: {
        text: note.text,
        years: note.years,
        origin_iso3: note.originIso3,
        asylum_iso3: note.asylumIso3,
        population_types: note.populationTypes,
        rows_matched: matched,
      },
      first,
      general: !note.originIso3 && !note.asylumIso3,
    });
  }

  // Array#sort is stable, so ties keep UNHCR's order.
  ranked.sort(
    (a, b) =>
      Number(a.first >= inline) - Number(b.first >= inline) ||
      Number(a.general) - Number(b.general) ||
      a.first - b.first,
  );
  return {
    footnotes: ranked.slice(0, FOOTNOTE_CAP).map(({ entry }) => entry),
    total: ranked.length,
  };
}
