/**
 * @fileoverview Aggregation for the asylum tools: filter → group by the
 * requested split dimensions plus unit → sum → (decisions) substantive
 * decisions and UNHCR's two rates. Upstream rows are split by authority ×
 * stage × decision level × unit; the server sums over the dimensions the
 * caller did not name. Unit is always a grouping key, so counts of cases are
 * never added to counts of persons, and rates are computed after aggregation
 * from summed counts, never averaged.
 * @module services/unhcr/asylum-aggregate
 */

import { pickIdentity } from './normalize.js';
import {
  APPLICATION_FIELDS,
  type AsylumApplicationRow,
  type AsylumDecisionRow,
  DECISION_FIELDS,
  type RowIdentity,
} from './types.js';

/** A procedure dimension an asylum result can be split by. */
export type AsylumDimension = 'authority' | 'decision_level' | 'stage';

/** What a count counts. */
export type AsylumUnit = 'cases' | 'persons';

/** A `Map`, so upstream unit text such as `constructor` never resolves through `Object.prototype`. */
const UNIT_BY_CODE: ReadonlyMap<string, AsylumUnit> = new Map([
  ['P', 'persons'],
  ['C', 'cases'],
]);

/** Output key listing the codes summed into a row, per dimension. */
const LIST_KEY = {
  authority: 'authorities',
  stage: 'stages',
  decision_level: 'decision_levels',
} as const satisfies Record<AsylumDimension, string>;

/** The codes summed into one aggregated row, keyed by output name. */
type CodeLists<D extends AsylumDimension> = { [K in D as (typeof LIST_KEY)[K]]: string[] };

/** One aggregated row: identity, the codes it sums, its unit, and summed counts. */
export type AggregatedRow<D extends AsylumDimension, C extends string> = RowIdentity &
  CodeLists<D> & { unit: AsylumUnit } & Record<C, number | null>;

/** Result of an aggregation. */
export interface Aggregation<R> {
  rows: R[];
  /** Rows left out because their unit code was neither P nor C. */
  skippedRows: number;
}

type SourceRow<D extends AsylumDimension, C extends string> = RowIdentity &
  Record<D, string | null> & { unit: string | null } & Record<C, number | null>;

interface Group<D extends AsylumDimension, C extends string> {
  codes: Record<D, Set<string>>;
  /** Count columns at least one row summed into the group left null. */
  gaps: Set<C>;
  identity: RowIdentity;
  sums: Record<C, number | null>;
  unit: AsylumUnit;
}

const identityKey = (row: RowIdentity): string =>
  [row.year, row.origin_iso3, row.origin_unhcr_code, row.asylum_iso3, row.asylum_unhcr_code].join(
    '|',
  );

/** Add a count into a running sum: null only while every value seen is null. */
const addCount = (sum: number | null, value: number | null): number | null =>
  value === null ? sum : (sum ?? 0) + value;

/**
 * Group rows by identity, the split dimensions, and unit, summing the count
 * columns, noting which columns any row left null, and collecting the codes
 * each group spans in every dimension. Groups are ordered persons before
 * cases, then by their split codes; callers sort by identity with a stable
 * sort, which keeps that order within a key.
 */
function aggregate<D extends AsylumDimension, C extends string>(
  rows: readonly SourceRow<D, C>[],
  dimensions: readonly D[],
  splitBy: readonly D[],
  counts: readonly C[],
): { groups: Group<D, C>[]; skippedRows: number } {
  const split = dimensions.filter((dimension) => splitBy.includes(dimension));
  const groups = new Map<string, Group<D, C> & { order: string }>();
  let skippedRows = 0;

  for (const row of rows) {
    const unit = row.unit === null ? undefined : UNIT_BY_CODE.get(row.unit);
    if (!unit) {
      skippedRows++;
      continue;
    }
    const splitCodes = split.map((dimension) => row[dimension] ?? '').join('|');
    const key = `${identityKey(row)}#${unit}#${splitCodes}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        identity: pickIdentity(row),
        unit,
        codes: Object.fromEntries(dimensions.map((d) => [d, new Set<string>()])) as Record<
          D,
          Set<string>
        >,
        sums: Object.fromEntries(counts.map((c) => [c, null])) as Record<C, number | null>,
        gaps: new Set<C>(),
        order: `${unit === 'persons' ? 0 : 1}|${splitCodes}`,
      };
      groups.set(key, group);
    }
    for (const dimension of dimensions) {
      const code = row[dimension];
      if (code !== null) group.codes[dimension].add(code);
    }
    for (const count of counts) {
      if (row[count] === null) group.gaps.add(count);
      group.sums[count] = addCount(group.sums[count], row[count]);
    }
  }

  const ordered = [...groups.values()].sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
  );
  return { groups: ordered, skippedRows };
}

/** Code lists in output shape, each sorted. */
function codeLists<D extends AsylumDimension>(
  codes: Record<D, Set<string>>,
  dimensions: readonly D[],
): CodeLists<D> {
  return Object.fromEntries(
    dimensions.map((dimension) => [LIST_KEY[dimension], [...codes[dimension]].sort()]),
  ) as CodeLists<D>;
}

/** Keep rows whose code in `field` is one of `codes`; an empty list keeps everything. */
function filterByCode<R, K extends keyof R>(
  rows: readonly R[],
  field: K,
  codes: readonly string[],
): readonly R[] {
  if (codes.length === 0) return rows;
  const wanted = new Set(codes);
  return rows.filter((row) => {
    const code = row[field];
    return typeof code === 'string' && wanted.has(code);
  });
}

const APPLICATION_DIMENSIONS = ['authority', 'stage', 'decision_level'] as const;
const DECISION_DIMENSIONS = ['authority', 'decision_level'] as const;

/** An aggregated asylum-applications row. */
export type ApplicationAggregate = AggregatedRow<
  (typeof APPLICATION_DIMENSIONS)[number],
  'applied'
>;

/** Sum applications over every dimension not in `splitBy`, after the `stages` filter. */
export function aggregateApplications(
  rows: readonly AsylumApplicationRow[],
  options: { splitBy: readonly AsylumDimension[]; stages: readonly string[] },
): Aggregation<ApplicationAggregate> {
  const filtered = filterByCode(rows, 'stage', options.stages);
  const { groups, skippedRows } = aggregate(
    filtered,
    APPLICATION_DIMENSIONS,
    options.splitBy,
    APPLICATION_FIELDS,
  );
  return {
    skippedRows,
    rows: groups.map((group) => ({
      ...group.identity,
      ...codeLists(group.codes, APPLICATION_DIMENSIONS),
      unit: group.unit,
      applied: group.sums.applied,
    })),
  };
}

/** An aggregated asylum-decisions row, with UNHCR's two rates. */
export interface DecisionAggregate
  extends AggregatedRow<(typeof DECISION_DIMENSIONS)[number], never> {
  complementary_protection: number | null;
  otherwise_closed: number | null;
  recognized: number | null;
  /** Recognized ÷ substantive decisions × 100, 1 dp; null when the denominator is null or 0. */
  refugee_recognition_rate: number | null;
  rejected: number | null;
  /** Recognized + complementary protection + rejected; null when any of the three is null in any row summed into it. */
  substantive_decisions: number | null;
  /** Sum of UNHCR's published totals, which rounding can set apart from the four outcomes. */
  total_decisions: number | null;
  /** (Recognized + complementary protection) ÷ substantive decisions × 100, 1 dp; null like the recognition rate. */
  total_protection_rate: number | null;
}

/** A percentage to one decimal place, or null when the denominator is empty or unknown. */
function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** The outcomes substantive decisions sums. */
const SUBSTANTIVE_OUTCOMES = ['dec_recognized', 'dec_other', 'dec_rejected'] as const;

/**
 * Sum decisions over every dimension not in `splitBy`, after the
 * `decisionLevels` filter, then compute substantive decisions and the rates
 * from the summed counts. Substantive decisions stay null when any of the
 * three outcomes is null in any row summed into the group: a sum over the
 * rest would rate a partial denominator, which puts the total protection
 * rate at 100% when only `rejected` is missing.
 */
export function aggregateDecisions(
  rows: readonly AsylumDecisionRow[],
  options: {
    decisionLevels: readonly string[];
    splitBy: readonly (typeof DECISION_DIMENSIONS)[number][];
  },
): Aggregation<DecisionAggregate> {
  const filtered = filterByCode(rows, 'decision_level', options.decisionLevels);
  const { groups, skippedRows } = aggregate(
    filtered,
    DECISION_DIMENSIONS,
    options.splitBy,
    DECISION_FIELDS,
  );
  return {
    skippedRows,
    rows: groups.map((group) => {
      const recognized = group.sums.dec_recognized;
      const complementary = group.sums.dec_other;
      const rejected = group.sums.dec_rejected;
      const outcomesKnown =
        recognized !== null &&
        complementary !== null &&
        rejected !== null &&
        !SUBSTANTIVE_OUTCOMES.some((outcome) => group.gaps.has(outcome));
      const substantive = outcomesKnown ? recognized + complementary + rejected : null;
      const protectedCount = outcomesKnown ? recognized + complementary : null;
      return {
        ...group.identity,
        ...codeLists(group.codes, DECISION_DIMENSIONS),
        unit: group.unit,
        recognized,
        complementary_protection: complementary,
        rejected,
        otherwise_closed: group.sums.dec_closed,
        total_decisions: group.sums.dec_total,
        substantive_decisions: substantive,
        refugee_recognition_rate: rate(recognized, substantive),
        total_protection_rate: rate(protectedCount, substantive),
      };
    }),
  };
}
