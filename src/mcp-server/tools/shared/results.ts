/**
 * @fileoverview The tail every unhcr_get_* data tool shares: sort the full
 * result, cut it to `limit`, stage it as a dataframe when it overflows (or on
 * request), compose one notice, and disclose truncation. Staging is
 * best-effort: a failure — the region-map load included — keeps the inline
 * rows and says so in the notice; only a cancelled request rethrows. The
 * failure's cause goes to the server-only log, not the client-visible one.
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
import type { RowIdentity } from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
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

const compareIdentity = (a: RowIdentity, b: RowIdentity): number =>
  a.year - b.year ||
  compareCode(a.origin_iso3, b.origin_iso3) ||
  compareCode(a.asylum_iso3, b.asylum_iso3);

/**
 * Sort a copy of the full result. `year` orders by year, then origin ISO3,
 * then asylum ISO3, ascending; a count field orders descending with nulls
 * last, ties broken the same way.
 */
export function sortRows<R extends RowIdentity>(rows: readonly R[], sortBy: keyof R): R[] {
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

/** Identity and region columns every staged table starts with. */
const STAGED_IDENTITY_COLUMNS: ColumnSchema[] = [
  nullable('year', 'INTEGER'),
  ...(['origin', 'asylum'] as const).flatMap((dimension) => [
    nullable(`${dimension}_iso3`, 'VARCHAR'),
    nullable(`${dimension}_unhcr_code`, 'VARCHAR'),
    nullable(`${dimension}_name`, 'VARCHAR'),
    nullable(`${dimension}_unhcr_region`, 'VARCHAR'),
    nullable(`${dimension}_unsd_region`, 'VARCHAR'),
  ]),
];

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

/** Stage the sorted full result with region columns; `undefined` when it could not be staged. */
async function stage<R extends RowIdentity>(
  ctx: Context,
  input: FinishInput<R>,
  sorted: readonly R[],
): Promise<StagedDataset | undefined> {
  const bridge = getCanvasBridge();
  if (!bridge?.available) return;
  try {
    const service = getUnhcrService();
    const [regions, countries] = await Promise.all([service.regions(ctx), service.countries(ctx)]);
    const unhcrRegion = (iso3: string | null) =>
      iso3 === null ? null : (regions.regionByIso3.get(iso3) ?? null);
    const unsdRegion = (iso3: string | null) =>
      iso3 === null ? null : (countries.table.byIso3.get(iso3)?.unsdRegion ?? null);
    const rows = sorted.map((row) => {
      const staged: Record<string, unknown> = {
        year: row.year,
        origin_iso3: row.origin_iso3,
        origin_unhcr_code: row.origin_unhcr_code,
        origin_name: row.origin_name,
        origin_unhcr_region: unhcrRegion(row.origin_iso3),
        origin_unsd_region: unsdRegion(row.origin_iso3),
        asylum_iso3: row.asylum_iso3,
        asylum_unhcr_code: row.asylum_unhcr_code,
        asylum_name: row.asylum_name,
        asylum_unhcr_region: unhcrRegion(row.asylum_iso3),
        asylum_unsd_region: unsdRegion(row.asylum_iso3),
      };
      for (const field of input.countFields) {
        const value = row[field];
        staged[field] = Array.isArray(value) ? value.join(',') : (value ?? null);
      }
      return staged;
    });
    return await bridge.register(ctx, {
      sourceTool: input.sourceTool,
      queryParams: input.queryParams,
      rows,
      schema: [
        ...STAGED_IDENTITY_COLUMNS,
        ...input.countFields.map((field) =>
          nullable(field, input.columnTypes?.[field] ?? 'INTEGER'),
        ),
      ],
      complete: input.complete,
      providers: input.providers,
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

/**
 * Sort, cut, stage, and explain a data tool's full result. Writes the notice
 * (or the truncation disclosure carrying it) through `ctx.enrich`, composing
 * every fragment into one string since `notice` is last-wins.
 */
export async function finishRows<R extends RowIdentity>(
  ctx: Context,
  input: FinishInput<R>,
): Promise<FinishedRows<R>> {
  const sorted = sortRows(input.rows, input.sortBy);
  const total = sorted.length;
  const rows = sorted.slice(0, input.limit);
  const overflow = total > input.limit;
  const fragments = [...input.scope.clamps];
  if (total === 0) {
    fragments.push(input.emptyNotice ?? emptyResultNotice(input));
  }
  fragments.push(...input.notices);
  if (!input.complete) {
    fragments.push(
      `The fetch stopped at the server's row cap after ${input.fetchedRows} upstream rows, so this result is partial. Narrow the year window, or list countries instead of expanding a dimension, to get a complete result.`,
    );
  }

  let dataset: StagedDataset | undefined;
  if (total > 0 && (overflow || input.stage)) {
    if (getCanvasBridge()?.available) {
      dataset = await stage(ctx, input, sorted);
      fragments.push(
        dataset
          ? dataframeGuidance(dataset)
          : 'The full set could not be staged as a dataframe; narrow the filters or year window, or raise limit (max 500), so it fits inline.',
      );
    } else if (overflow) {
      fragments.push(
        `Showing ${rows.length} of ${total} rows. Dataframes are unavailable in this deployment, so narrow the filters or year window, or raise limit (max 500), to see the rest.`,
      );
    } else {
      fragments.push('stage was ignored: dataframes are unavailable in this deployment.');
    }
  }

  const notice = fragments.join(' ');
  if (overflow) ctx.enrich.truncated({ shown: rows.length, cap: input.limit, guidance: notice });
  else if (notice) ctx.enrich.notice(notice);

  return {
    rows,
    total_rows: total,
    complete: input.complete,
    applied_scope: input.scope.applied,
    latest_year: input.scope.coverage.latestYear,
    ...(dataset && { dataset }),
    attribution: buildAttribution(input.providers),
  };
}
