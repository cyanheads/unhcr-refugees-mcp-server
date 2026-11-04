/**
 * @fileoverview The tail every unhcr_get_* data tool shares: sort the full
 * result, cut it to `limit` (clamped at its cap), stage it as a dataframe
 * when it overflows (or on request), compose one notice, and disclose
 * truncation. unhcr_get_population's nowcast takes the same path as a table
 * of its own, at the same effective limit. Staging is best-effort: a failure
 * — the region-map load included — keeps the inline rows and says so in the
 * notice; only a cancelled request rethrows. The failure's cause goes to the
 * server-only log, not the client-visible one.
 * @module mcp-server/tools/shared/results
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { logger, withExtra } from '@cyanheads/mcp-ts-core/utils';
import {
  dataframeGuidance,
  errorText,
  getCanvasBridge,
  type StagedDataset,
} from '@/services/canvas-bridge/canvas-bridge.js';
import {
  ATTRIBUTION_SOURCE,
  DATA_LICENSE,
  type Provider,
  TERMS_URL,
} from '@/services/unhcr/codes.js';
import type { NowcastRow, RowIdentity } from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { clampCount } from './counts.js';
import { LIMIT_CAP } from './inputs.js';
import { type AppliedScope, type Attribution, yearSpan } from './outputs.js';
import type { ResolvedScope } from './scope.js';

/** The attribution object every result carrying UNHCR figures returns. */
export function buildAttribution(providers: readonly Provider[]): Attribution {
  return {
    source: ATTRIBUTION_SOURCE,
    license: DATA_LICENSE,
    terms_url: TERMS_URL,
    providers: [...new Set(providers)].sort(),
  };
}

const compareCode = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
};

/** The identity {@link sortRows} orders by; a nowcast row has no origin. */
type SortIdentity = Pick<RowIdentity, 'asylum_iso3' | 'year'> & { origin_iso3?: string | null };

const compareIdentity = (a: SortIdentity, b: SortIdentity): number =>
  a.year - b.year ||
  compareCode(a.origin_iso3 ?? null, b.origin_iso3 ?? null) ||
  compareCode(a.asylum_iso3, b.asylum_iso3);

/**
 * Sort a copy of the full result. `year` orders by year, then origin ISO3
 * (for rows that have one), then asylum ISO3, ascending; a count field orders
 * descending with nulls last, ties broken the same way.
 */
export function sortRows<R extends SortIdentity>(rows: readonly R[], sortBy: keyof R): R[] {
  if (sortBy === 'year') return [...rows].sort(compareIdentity);
  const countOf = (row: R): number | null => {
    const value = row[sortBy];
    return typeof value === 'number' ? value : null;
  };
  return [...rows].sort((a, b) => {
    const va = countOf(a);
    const vb = countOf(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va;
    }
    return compareIdentity(a, b);
  });
}

const nullable = (name: string, type: ColumnSchema['type']): ColumnSchema => ({
  name,
  type,
  nullable: true,
});

/** One dimension's identity and region columns, in staged order. */
const dimensionColumns = (dimension: 'asylum' | 'origin'): ColumnSchema[] => [
  nullable(`${dimension}_iso3`, 'VARCHAR'),
  nullable(`${dimension}_unhcr_code`, 'VARCHAR'),
  nullable(`${dimension}_name`, 'VARCHAR'),
  nullable(`${dimension}_unhcr_region`, 'VARCHAR'),
  nullable(`${dimension}_unsd_region`, 'VARCHAR'),
];

/** Identity and region columns every staged year-end table starts with. */
const STAGED_IDENTITY_COLUMNS: ColumnSchema[] = [
  nullable('year', 'INTEGER'),
  ...dimensionColumns('origin'),
  ...dimensionColumns('asylum'),
];

/**
 * The staged nowcast's columns: no origin, since the nowcast has none, so its
 * shape tells it apart from a year-end table in unhcr_dataframe_describe.
 */
const NOWCAST_COLUMNS: ColumnSchema[] = [
  nullable('year', 'INTEGER'),
  nullable('month', 'VARCHAR'),
  ...dimensionColumns('asylum'),
  nullable('refugees', 'INTEGER'),
  nullable('asylum_seekers', 'INTEGER'),
  nullable('source', 'VARCHAR'),
];

/** The nowcast's count columns, the `sort_by` values that order it. */
const NOWCAST_COUNTS = ['refugees', 'asylum_seekers'] as const;

/** Everything {@link finishRows} needs to cut, stage, and explain a result. */
export interface FinishInput<R extends RowIdentity> {
  /**
   * Types for staged columns that are not INTEGER counts (codes, rates, flags).
   * An array value is staged as its elements joined with commas.
   */
  columnTypes?: Partial<Record<keyof R & string, ColumnSchema['type']>>;
  complete: boolean;
  /**
   * Fields the staged table carries after identity and regions, in order:
   * INTEGER columns unless `columnTypes` names another type.
   */
  countFields: readonly (keyof R & string)[];
  /** Dataset name used in the empty-result notice ("population", "solutions"). */
  datasetLabel: string;
  /**
   * Replaces the default empty-result notice, for a result a tool-local code
   * filter or the unit skip emptied after UNHCR returned rows.
   */
  emptyNotice?: string | undefined;
  /**
   * Upstream rows the fetch returned, which the partial-result notice names:
   * each fetched series' `rows` plus its `skippedRows`, since the year-less
   * rows the service left out were fetched too. A tool that joins companion
   * series counts every series it fetched, since any one of them can hit the
   * cap. Aggregation and code filters make `rows` here a different count.
   */
  fetchedRows: number;
  limit: number;
  /** Tool-specific notice fragments, placed after the clamp and empty-result ones. */
  notices: string[];
  /**
   * unhcr_get_population's nowcast, finished as a table of its own beside
   * `rows`: sorted by `sortBy` when it names a nowcast count (otherwise by
   * asylum ISO3), cut at the same effective limit, and staged when it
   * overflows or on request. Its notice fragments follow the year-end ones.
   */
  nowcast?: readonly NowcastRow[] | undefined;
  providers: Provider[];
  queryParams: Record<string, unknown>;
  rows: readonly R[];
  /**
   * The resolved scope: its codes, window, and clamps shape the notice, and
   * it fills `applied_scope` and `latest_year`.
   */
  scope: ResolvedScope;
  sortBy: keyof R;
  sourceTool: string;
  stage: boolean;
  /**
   * Upstream rows left out for want of a usable year (the fetched series'
   * `skippedRows`). When a result is empty and this is above 0, the
   * empty-result notice says UNHCR did return rows instead of suggesting a
   * wider window.
   */
  yearlessRows: number;
}

/** The shared part of a data tool's output. */
export interface FinishedRows<R> {
  applied_scope: AppliedScope;
  attribution: Attribution;
  complete: boolean;
  dataset?: StagedDataset;
  latest_year: number;
  rows: R[];
  total_rows: number;
}

/** The default empty-result notice, per the design's fragment table. */
function emptyResultNotice<R extends RowIdentity>({
  datasetLabel,
  scope,
  yearlessRows,
}: FinishInput<R>): string {
  const years = yearSpan(scope.query.yearFrom, scope.query.yearTo);
  if (yearlessRows > 0) {
    return `UNHCR returned ${yearlessRows} row(s) for this scope, all without a usable year, so none could be placed in ${years}; they were left out rather than guessed.`;
  }
  const origin = scope.origin.codes;
  const asylum = scope.asylum.codes;
  if (origin.length > 0 && asylum.length > 0) {
    return `No rows for origin ${origin.join(', ')} in asylum ${asylum.join(', ')} in ${years}. Origin is where people fled from and asylum where they sought or hold protection (for returns, the country they returned from); swapping them is the common miss.`;
  }
  const filtered = origin.length > 0 ? origin : asylum;
  if (filtered.length > 0) {
    return `UNHCR reports no ${datasetLabel} rows for ${filtered.join(', ')} in ${years}. Widen the year window, or check the dataset's span with unhcr_list_reference (topic coverage).`;
  }
  return `No rows for ${years}. Check the dataset's span with unhcr_list_reference (topic coverage).`;
}

/** A country's UNHCR bureau and UNSD region by ISO3, for staged region columns. */
interface RegionLookup {
  unhcr: (iso3: string | null) => string | null;
  unsd: (iso3: string | null) => string | null;
}

/** One table to stage: its column schema, provenance, and rows built over the region lookup. */
interface StagedTable {
  complete: boolean;
  providers: Provider[];
  rows: (regions: RegionLookup) => Record<string, unknown>[];
  schema: ColumnSchema[];
}

/** The year-end rows as a staged table, at the same grain as `rows`. */
function yearEndTable<R extends RowIdentity>(
  input: FinishInput<R>,
  sorted: readonly R[],
): StagedTable {
  return {
    complete: input.complete,
    providers: input.providers,
    schema: [
      ...STAGED_IDENTITY_COLUMNS,
      ...input.countFields.map((field) => nullable(field, input.columnTypes?.[field] ?? 'INTEGER')),
    ],
    rows: (regions) =>
      sorted.map((row) => {
        const staged: Record<string, unknown> = {
          year: row.year,
          origin_iso3: row.origin_iso3,
          origin_unhcr_code: row.origin_unhcr_code,
          origin_name: row.origin_name,
          origin_unhcr_region: regions.unhcr(row.origin_iso3),
          origin_unsd_region: regions.unsd(row.origin_iso3),
          asylum_iso3: row.asylum_iso3,
          asylum_unhcr_code: row.asylum_unhcr_code,
          asylum_name: row.asylum_name,
          asylum_unhcr_region: regions.unhcr(row.asylum_iso3),
          asylum_unsd_region: regions.unsd(row.asylum_iso3),
        };
        for (const field of input.countFields) {
          const value = row[field];
          staged[field] = Array.isArray(value) ? value.join(',') : (value ?? null);
        }
        return staged;
      }),
  };
}

/** The nowcast as a staged table of its own, kept apart from the year-end rows it overlaps. */
function nowcastTable(sorted: readonly NowcastRow[]): StagedTable {
  return {
    // The nowcast is one page of about 200 rows, far below the row cap, so its walk is never cut short.
    complete: true,
    providers: [],
    schema: NOWCAST_COLUMNS,
    rows: (regions) =>
      sorted.map((row) => ({
        year: row.year,
        month: row.month,
        asylum_iso3: row.asylum_iso3,
        asylum_unhcr_code: row.asylum_unhcr_code,
        asylum_name: row.asylum_name,
        asylum_unhcr_region: regions.unhcr(row.asylum_iso3),
        asylum_unsd_region: regions.unsd(row.asylum_iso3),
        refugees: row.refugees,
        asylum_seekers: row.asylum_seekers,
        source: row.source,
      })),
  };
}

/** Stage one table with region columns; `undefined` when it could not be staged. */
async function stage<R extends RowIdentity>(
  ctx: Context,
  input: FinishInput<R>,
  table: StagedTable,
): Promise<StagedDataset | undefined> {
  const bridge = getCanvasBridge();
  if (!bridge?.available) return;
  try {
    const service = getUnhcrService();
    const [regions, countries] = await Promise.all([service.regions(ctx), service.countries(ctx)]);
    const rows = table.rows({
      unhcr: (iso3) => (iso3 === null ? null : (regions.regionByIso3.get(iso3) ?? null)),
      unsd: (iso3) =>
        iso3 === null ? null : (countries.table.byIso3.get(iso3)?.unsdRegion ?? null),
    });
    return await bridge.register(ctx, {
      sourceTool: input.sourceTool,
      queryParams: input.queryParams,
      rows,
      schema: table.schema,
      complete: table.complete,
      providers: table.providers,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const message = 'Region data for staging could not load; the inline rows stand';
    ctx.log.warning(message, { sourceTool: input.sourceTool });
    logger.warning(
      message,
      withExtra(ctx, { sourceTool: input.sourceTool, error: errorText(error) }),
    );
    return;
  }
}

/** unhcr_get_population's nowcast output fields, as {@link finishRows} finishes them. */
export interface FinishedNowcast {
  /** The sorted nowcast cut to the effective limit. */
  nowcast: NowcastRow[];
  nowcast_dataset?: StagedDataset;
  /** Nowcast rows before the cut. */
  nowcast_total: number;
}

/** What {@link finishRows} hands back to the tool handler. */
export interface FinishResult<R> {
  /**
   * The effective inline row count for this call: the caller's `limit` after
   * the clamp at {@link LIMIT_CAP}. `output.rows` is the sorted result cut to
   * it. Kept beside `output`, out of `structuredContent`, for handler logic
   * that must agree with the cut.
   */
  limit: number;
  /** Present when `input.nowcast` was given. */
  nowcast?: FinishedNowcast;
  output: FinishedRows<R>;
  /** The full result in sort order; `output.rows` is its first `limit` rows. */
  sorted: R[];
}

/** The pointer that travels with every `nowcast_dataset` handle. */
const nowcastGuidance = (dataset: StagedDataset): string =>
  `The nowcast is staged as its own dataframe, ${dataset.name} (${dataset.row_count} rows); inspect it with unhcr_dataframe_describe and query it with unhcr_dataframe_query.`;

/**
 * Sort, cut, and stage the nowcast at the call's effective limit, returning
 * its output fields and notice fragments. `canvasOn` is read once per call, so
 * a canvas that latched off while the year-end rows staged reads as a failed
 * staging here too; `canvasOffSaid` is whether a year-end fragment already
 * said dataframes are unavailable, so it is said once.
 */
async function finishNowcast<R extends RowIdentity>(
  ctx: Context,
  input: FinishInput<R>,
  rows: readonly NowcastRow[],
  call: { canvasOffSaid: boolean; canvasOn: boolean; limit: number },
): Promise<{ fragments: string[]; output: FinishedNowcast }> {
  const sorted = sortRows(rows, NOWCAST_COUNTS.find((field) => field === input.sortBy) ?? 'year');
  const total = sorted.length;
  const shown = sorted.slice(0, call.limit);
  const overflow = total > call.limit;
  const fragments: string[] = [];
  let dataset: StagedDataset | undefined;
  if (total > 0 && (overflow || input.stage)) {
    if (call.canvasOn) dataset = await stage(ctx, input, nowcastTable(sorted));
    const cut = `Showing ${shown.length} of ${total} nowcast rows`;
    const raise = `raise limit (max ${LIMIT_CAP}) to see the rest.`;
    if (dataset) {
      fragments.push(overflow ? `${cut}. ${nowcastGuidance(dataset)}` : nowcastGuidance(dataset));
    } else if (call.canvasOn) {
      fragments.push(
        overflow
          ? `${cut}. The full nowcast could not be staged as a dataframe, so ${raise}`
          : 'The nowcast could not be staged as a dataframe; every nowcast row is inline.',
      );
    } else if (overflow) {
      fragments.push(
        call.canvasOffSaid
          ? `${cut}; ${raise}`
          : `${cut}. Dataframes are unavailable in this deployment, so ${raise}`,
      );
    } else if (!call.canvasOffSaid) {
      fragments.push('stage was ignored: dataframes are unavailable in this deployment.');
    }
  }
  return {
    fragments,
    output: {
      nowcast: shown,
      nowcast_total: total,
      ...(dataset && { nowcast_dataset: dataset }),
    },
  };
}

/**
 * Sort, cut, stage, and explain a data tool's full result. Clamps `limit` at
 * {@link LIMIT_CAP}, then writes the notice (or the truncation disclosure
 * carrying it) through `ctx.enrich`, composing every fragment into one string
 * since `notice` is last-wins. A nowcast, when given, is finished at the same
 * limit and its fragments join that notice; `truncated`, `shown`, and `cap`
 * describe `rows` alone.
 */
export async function finishRows<R extends RowIdentity>(
  ctx: Context,
  input: FinishInput<R>,
): Promise<FinishResult<R>> {
  const sorted = sortRows(input.rows, input.sortBy);
  const total = sorted.length;
  const clamp = clampCount(ctx, {
    tool: input.sourceTool,
    field: 'limit',
    requested: input.limit,
    cap: LIMIT_CAP,
  });
  const limit = clamp.effective;
  const rows = sorted.slice(0, limit);
  const overflow = total > limit;
  const fragments = [...input.scope.clamps];
  if (clamp.notice) fragments.push(clamp.notice);
  if (total === 0) {
    fragments.push(input.emptyNotice ?? emptyResultNotice(input));
  }
  fragments.push(...input.notices);
  if (!input.complete) {
    fragments.push(
      `The fetch stopped at the server's row cap after ${input.fetchedRows} upstream rows, so this result is partial. Narrow the year window, or list countries instead of expanding a dimension, to get a complete result.`,
    );
  }

  const canvasOn = getCanvasBridge()?.available === true;
  let canvasOffSaid = false;
  let dataset: StagedDataset | undefined;
  if (total > 0 && (overflow || input.stage)) {
    // At the cap, raising limit shows nothing more, so only narrowing is offered.
    const raiseLimit = limit < LIMIT_CAP ? `, or raise limit (max ${LIMIT_CAP}),` : '';
    if (canvasOn) {
      dataset = await stage(ctx, input, yearEndTable(input, sorted));
      fragments.push(
        dataset
          ? dataframeGuidance(dataset)
          : `The full set could not be staged as a dataframe; narrow the filters or year window${raiseLimit} so it fits inline.`,
      );
    } else {
      fragments.push(
        overflow
          ? `Showing ${rows.length} of ${total} rows. Dataframes are unavailable in this deployment, so narrow the filters or year window${raiseLimit} to see the rest.`
          : 'stage was ignored: dataframes are unavailable in this deployment.',
      );
      canvasOffSaid = true;
    }
  }

  const nowcast =
    input.nowcast &&
    (await finishNowcast(ctx, input, input.nowcast, { canvasOffSaid, canvasOn, limit }));
  if (nowcast) fragments.push(...nowcast.fragments);

  const notice = fragments.join(' ');
  if (overflow) ctx.enrich.truncated({ shown: rows.length, cap: limit, guidance: notice });
  else if (notice) ctx.enrich.notice(notice);

  return {
    output: {
      rows,
      total_rows: total,
      complete: input.complete,
      applied_scope: input.scope.applied,
      latest_year: input.scope.coverage.latestYear,
      ...(dataset && { dataset }),
      attribution: buildAttribution(input.providers),
    },
    limit,
    ...(nowcast && { nowcast: nowcast.output }),
    sorted,
  };
}
