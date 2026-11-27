/**
 * @fileoverview Client for the UNHCR Refugee Statistics API
 * (`https://api.unhcr.org/population/v1`, keyless). Owns every upstream
 * behavior the tools rely on: the request builder (the only place URLs are
 * made), a paced + retried + deadline-bounded fetch through an injectable
 * `fetch`, an LRU response cache, single-flight of identical in-flight
 * requests, the page walk, envelope validation, value normalization, and the
 * reference data (countries, UNHCR regions, dataset coverage, footnotes)
 * cached for 24 hours.
 *
 * The upstream fails silently rather than loudly: an unknown parameter is
 * ignored, a lone year bound returns the full history, and a code from the
 * wrong system matches a different country. The builder therefore sends
 * allowlisted parameters only, always pairs `yearFrom`/`yearTo`, and adds
 * `cf_type=ISO` to every request.
 * @module services/unhcr/unhcr-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  isRecord,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ProbedDataset } from './codes.js';
import { buildCountryTable, type CountryTable } from './country-input.js';
import { type Footnote, toFootnote } from './footnote-match.js';
import { toCount, toDataRow, toIdentityText, toYear, type ValueTally } from './normalize.js';
import { MAX_CACHED_BODY, ResponseCache } from './response-cache.js';
import { isLoadDeadline, loadDeadline, SharedLoad } from './shared-load.js';
import {
  APPLICATION_FIELDS,
  type AsylumApplicationRow,
  type AsylumCodes,
  type AsylumDecisionRow,
  type CompanionRow,
  type Country,
  type Coverage,
  type DataRow,
  type DatasetQuery,
  type DatasetResult,
  DECISION_FIELDS,
  DEMOGRAPHICS_FIELDS,
  type DemographicsRow,
  type DimensionScope,
  type Endpoint,
  type Envelope,
  type NowcastPeriod,
  type NowcastResult,
  type NowcastRow,
  POPULATION_FIELDS,
  type PopulationRow,
  type RawRow,
  SOLUTIONS_FIELDS,
  type SolutionsRow,
  type UnhcrRegion,
} from './types.js';

const BASE_URL = 'https://api.unhcr.org/population/v1';
const REQUEST_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'unhcr-refugees-mcp-server (+https://github.com/cyanheads/unhcr-refugees-mcp-server)',
};

/** Rows per data page. Upstream enforces no ceiling; 10,000 keeps a page near 2.8 MB. */
export const PAGE_SIZE = 10_000;
/** Wall-clock budget for all upstream work of one tool call. */
export const CALL_BUDGET_MS = 45_000;
const ATTEMPT_TIMEOUT_MS = 30_000;
const RESPONSE_TTL_MS = 6 * 60 * 60 * 1000;
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_MAX_AGE_MS = 7 * REFERENCE_TTL_MS;
const REFERENCE_REFRESH_COOLDOWN_MS = 60_000;
const REFERENCE_REFRESH_BUDGET_MS = 10_000;
const STALE_REFERENCES = {
  countries: 'countries',
  regions: 'regional bureaus',
  footnotes: 'footnotes',
} as const;
type StaleReference = keyof typeof STALE_REFERENCES;
type ReferenceKey = StaleReference | `coverage/${ProbedDataset}` | 'nowcast-period';
const referenceStaleness = new WeakMap<Context, Map<StaleReference, number>>();
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const OUTAGE_HINT = 'Wait briefly, then retry the same call.';
/** Deadline recovery with the response cache off: a retry starts the walk over. */
const DEADLINE_HINT =
  'Narrow the year window or drop expand so the call needs fewer upstream requests, then retry.';
/**
 * Deadline recovery with the cache on. Every page that finished before the
 * deadline is cached, so a prompt identical retry fetches only the rest; it
 * does not promise more, since other calls' pages can evict them meanwhile.
 */
const DEADLINE_RESUME_HINT =
  'Pages fetched before the deadline are cached, so retrying the identical call promptly resumes from them and fetches only the rest. If the retry also times out, narrow the year window or drop expand so the call needs fewer upstream requests.';

/** Plain-object configuration; the service never reads the environment itself. */
export interface UnhcrServiceConfig {
  /** Response-cache budget in UTF-16 code units (≈ bytes); `0` disables the cache. */
  cacheMaxBytes: number;
  /** Most upstream rows one call fetches before the walk stops with `complete: false`. */
  maxRows: number;
  /** Upstream request starts per second, process-wide. */
  requestsPerSecond: number;
}

/** Constructor options — the test seams named in the design's Test Boundary. */
export interface UnhcrServiceOptions {
  config: UnhcrServiceConfig;
  /** HTTP boundary; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Clock for cache and reference TTLs; defaults to `Date.now`. */
  now?: () => number;
}

/** Per-call options every public method accepts. */
export interface CallOptions {
  /** Budget for this method's upstream work, overriding the per-call 45 s deadline. */
  deadlineMs?: number;
}

/** UNHCR's country table with its lookup indexes. */
export interface CountryReference {
  list: Country[];
  table: CountryTable;
}

/** UNHCR's regional bureaus and the ISO3 → bureau-name map. */
export interface RegionReference {
  regionByIso3: ReadonlyMap<string, string>;
  regions: UnhcrRegion[];
}

/** Query parameters the request builder accepts. Every other name is unrepresentable. */
export interface RequestParams {
  coa?: readonly string[];
  coaAll?: boolean;
  coo?: readonly string[];
  cooAll?: boolean;
  limit?: number;
  page?: number;
  /** `/demographics/` only: one row per population type instead of a sum over all types. */
  ptypeShow?: boolean;
  unhcrRegion?: number;
  yearFrom?: number;
  yearTo?: number;
}

/**
 * Build a canonical request URL. Parameters are emitted in a fixed order so an
 * identical question always yields an identical cache and single-flight key.
 * Codes are pre-validated uppercase ISO3, so the comma list needs no encoding.
 */
export function buildUrl(endpoint: Endpoint, params: RequestParams = {}): string {
  if ((params.yearFrom === undefined) !== (params.yearTo === undefined)) {
    throw internalError('yearFrom and yearTo must be sent together: UNHCR ignores a lone bound.');
  }
  if ((params.coo?.length && params.cooAll) || (params.coa?.length && params.coaAll)) {
    throw internalError('A dimension cannot carry both a code list and *_all: *_all overrides it.');
  }
  const pairs: string[] = [];
  if (params.coo?.length) pairs.push(`coo=${params.coo.join(',')}`);
  if (params.coa?.length) pairs.push(`coa=${params.coa.join(',')}`);
  if (params.cooAll) pairs.push('coo_all=true');
  if (params.coaAll) pairs.push('coa_all=true');
  if (params.yearFrom !== undefined && params.yearTo !== undefined) {
    pairs.push(`yearFrom=${params.yearFrom}`, `yearTo=${params.yearTo}`);
  }
  if (params.unhcrRegion !== undefined) pairs.push(`unhcr_region=${params.unhcrRegion}`);
  if (params.ptypeShow) pairs.push('ptype_show=true');
  pairs.push('cf_type=ISO');
  if (params.limit !== undefined) pairs.push(`limit=${params.limit}`);
  if (params.page !== undefined) pairs.push(`page=${params.page}`);
  return `${BASE_URL}/${endpoint}/?${pairs.join('&')}`;
}

/** Request parameters for one country dimension. */
function dimensionParams(dimension: 'coa' | 'coo', scope: DimensionScope): RequestParams {
  if (scope.mode === 'listed') return { [dimension]: scope.codes };
  if (scope.mode === 'each') return dimension === 'coo' ? { cooAll: true } : { coaAll: true };
  return {};
}

/** Request parameters for a validated dataset query. */
function queryParams(query: DatasetQuery): RequestParams {
  return {
    ...dimensionParams('coo', query.origin),
    ...dimensionParams('coa', query.asylum),
    yearFrom: query.yearFrom,
    yearTo: query.yearTo,
  };
}

interface ReferencePage {
  accepts: (row: RawRow) => boolean;
  index: number;
  maxPages?: number;
}

/** Validate the envelope and any reference-specific pagination and row requirements. */
function parseEnvelope(body: string, reference?: ReferencePage): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw serviceUnavailable('UNHCR API returned a response that is not JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw serviceUnavailable('UNHCR API returned JSON without an items array.');
  }
  const maxPages = Number(parsed.maxPages);
  const items = parsed.items.filter(isRecord);
  if (reference) {
    if (!items.some(reference.accepts)) {
      throw serviceUnavailable('UNHCR API returned an empty reference list.');
    }
    if (
      parsed.page !== reference.index ||
      typeof parsed.maxPages !== 'number' ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < reference.index ||
      (reference.maxPages !== undefined && maxPages !== reference.maxPages)
    ) {
      throw serviceUnavailable('UNHCR API returned inconsistent pagination for a reference list.');
    }
  }
  return {
    items,
    maxPages: Number.isInteger(maxPages) && maxPages >= 0 ? maxPages : 1,
  };
}

/** A bounded outage can use an already complete reference list. */
function isTransientRefreshFailure(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.data?.retryable !== false &&
    (error.code === JsonRpcErrorCode.ServiceUnavailable ||
      error.code === JsonRpcErrorCode.Timeout ||
      error.code === JsonRpcErrorCode.RateLimited)
  );
}

/** Stale lists used by this caller, for the tool to compose with its other notices. */
export function staleReferenceNotices(ctx: Context): string[] {
  const stale = referenceStaleness.get(ctx);
  if (!stale) return [];
  return [...stale]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, ageMs]) => {
      const hours = Math.floor(ageMs / 3_600_000);
      return `Stale UNHCR ${STALE_REFERENCES[key]} (${hours} hours old) were used because the refresh failed.`;
    });
}

/**
 * Race a shared promise against one caller's cancellation. A caller already
 * cancelled still subscribes to `work`, so its failure is never an unhandled
 * rejection, which ends the process.
 */
function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Whole seconds to wait from a `retryAfter` that may be seconds or an HTTP-date. */
function retryAfterSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.ceil(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Math.max(1, Number(trimmed));
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.max(1, Math.ceil((at - Date.now()) / 1000));
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * The call's spent deadline as a `Timeout`. When the response cache can hold a
 * full page it is `retryable`, since the identical call resumes from the cached
 * pages; with the cache off or smaller than one page a retry repeats the same
 * walk, so only narrowing is offered.
 */
function deadlineExceeded(cacheMaxBytes: number, cause?: unknown): McpError {
  const resumable = cacheMaxBytes >= MAX_CACHED_BODY;
  const hint = resumable ? DEADLINE_RESUME_HINT : DEADLINE_HINT;
  return timeout(
    `UNHCR did not answer within this call's ${CALL_BUDGET_MS / 1000} s budget. ${hint}`,
    { ...(resumable && { retryable: true }), recovery: { hint } },
    cause === undefined ? undefined : { cause },
  );
}

function toCountry(raw: RawRow): Country | undefined {
  const unhcrCode = toIdentityText(raw.code);
  const name = toIdentityText(raw.name);
  if (!unhcrCode || !name) return;
  return {
    unhcrCode,
    iso3: toIdentityText(raw.iso),
    iso2: toIdentityText(raw.iso2),
    name,
    nameLong: toIdentityText(raw.nameLong),
    nameShort: toIdentityText(raw.nameShort),
    nameFormal: toIdentityText(raw.nameFormal),
    nameOrigin: toIdentityText(raw.nameOrigin),
    nationality: toIdentityText(raw.nationality),
    majorArea: toIdentityText(raw.majorArea),
    unsdRegion: toIdentityText(raw.region),
  };
}

function toBureau(raw: RawRow): { id: number; name: string } | undefined {
  const id = toYear(raw.id);
  const name = toIdentityText(raw.name);
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0 || !name) return;
  return { id, name };
}

/** The procedure codes an asylum row is split by; `unitColumn` differs per endpoint. */
function toAsylumCodes(raw: RawRow, unitColumn: 'app_pc' | 'dec_pc'): AsylumCodes {
  return {
    authority: toIdentityText(raw.procedure_type),
    decision_level: toIdentityText(raw.dec_level),
    unit: toIdentityText(raw[unitColumn]),
  };
}

/** Normalize one nowcast row; a row with no usable year is left out, and the caller counts it. */
function toNowcastRow(raw: RawRow, tally: ValueTally): NowcastRow | undefined {
  const year = toYear(raw.year);
  if (year === undefined) return;
  return {
    asylum_iso3: toIdentityText(raw.coa_iso),
    asylum_unhcr_code: toIdentityText(raw.coa),
    asylum_name: toIdentityText(raw.coa_name),
    year,
    month: toIdentityText(raw.month),
    refugees: toCount(raw.refugees, tally),
    asylum_seekers: toCount(raw.asylum_seekers, tally),
    source: toIdentityText(raw.source),
  };
}

interface ReferenceEntry {
  retryAt?: number;
  storedAt: number;
  value: unknown;
}

interface ReferenceResult {
  staleAgeMs?: number;
  value: unknown;
}

export class UnhcrApiService {
  private readonly cache: ResponseCache;
  private readonly callDeadlines = new WeakMap<object, number>();
  private readonly config: UnhcrServiceConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly inflight = new SharedLoad<Envelope>();
  private readonly now: () => number;
  private readonly pacer: Pacer;
  private readonly references = new Map<string, ReferenceEntry>();
  private readonly referenceLoads = new SharedLoad<ReferenceResult>();

  constructor(options: UnhcrServiceOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.cache = new ResponseCache(options.config.cacheMaxBytes, RESPONSE_TTL_MS, this.now);
    this.pacer = createPacer({
      name: 'unhcr-api',
      limits: [{ requests: options.config.requestsPerSecond, perMs: 1000 }],
      maxConcurrent: 2,
      cooldown: { baseMs: 5000, maxMs: 60_000 },
    });
  }

  /** Stop the pacer: queued requests reject with `RequestCancelled`. */
  dispose(): void {
    this.pacer.dispose();
  }

  /** UNHCR's country table (232 entries), cached 24 h. */
  countries(ctx: Context, options?: CallOptions): Promise<CountryReference> {
    return this.run(ctx, options, (deadlineAt) =>
      this.reference('countries', ctx, deadlineAt, async (refreshDeadlineAt) => {
        const items = await this.referenceItems('countries', {}, ctx, refreshDeadlineAt);
        const list = items.flatMap((raw) => toCountry(raw) ?? []);
        return { list, table: buildCountryTable(list) };
      }),
    );
  }

  /**
   * UNHCR's regional bureaus and their member countries, cached 24 h. Country
   * rows do not carry their bureau, so this costs one `/regions/` call plus one
   * `/countries/?unhcr_region=<id>` call per bureau on a cold cache.
   */
  regions(ctx: Context, options?: CallOptions): Promise<RegionReference> {
    return this.run(ctx, options, (deadlineAt) =>
      this.reference('regions', ctx, deadlineAt, async (refreshDeadlineAt) => {
        const items = await this.referenceItems('regions', {}, ctx, refreshDeadlineAt);
        const regions = await Promise.all(
          items.flatMap((raw) => {
            const bureau = toBureau(raw);
            if (!bureau) return [];
            return [
              this.referenceItems(
                'countries',
                { unhcrRegion: bureau.id },
                ctx,
                refreshDeadlineAt,
              ).then(
                (members): UnhcrRegion => ({
                  ...bureau,
                  countries: members.flatMap((member) => toIdentityText(member.iso) ?? []),
                }),
              ),
            ];
          }),
        );
        regions.sort((a, b) => a.name.localeCompare(b.name));
        const regionByIso3 = new Map<string, string>();
        for (const region of regions) {
          for (const iso3 of region.countries) regionByIso3.set(iso3, region.name);
        }
        return { regions, regionByIso3 };
      }),
    );
  }

  /**
   * First and latest year a dataset publishes, from its own year-sorted rows:
   * the first row of page 1 and the row on the last page at `limit=1`. Cached
   * 24 h. `/years/` is not used — it lists years that have no data.
   */
  coverage(dataset: ProbedDataset, ctx: Context, options?: CallOptions): Promise<Coverage> {
    return this.run(ctx, options, (deadlineAt) =>
      this.reference(`coverage/${dataset}`, ctx, deadlineAt, async () => {
        const first = await this.page(buildUrl(dataset, { limit: 1, page: 1 }), ctx, deadlineAt);
        const firstYear = toYear(first.items[0]?.year);
        const last =
          first.maxPages > 1
            ? await this.page(
                buildUrl(dataset, { limit: 1, page: first.maxPages }),
                ctx,
                deadlineAt,
              )
            : first;
        const latestYear = toYear(last.items[0]?.year);
        if (firstYear === undefined || latestYear === undefined) {
          throw serviceUnavailable(`UNHCR returned no rows while probing ${dataset} coverage.`);
        }
        return { firstYear, latestYear };
      }),
    );
  }

  /** The month and year of the current-year nowcast snapshot, cached 24 h. */
  nowcastPeriod(ctx: Context, options?: CallOptions): Promise<NowcastPeriod> {
    return this.run(ctx, options, (deadlineAt) =>
      this.reference('nowcast-period', ctx, deadlineAt, async () => {
        const first = await this.page(
          buildUrl('nowcasting', { limit: 1, page: 1 }),
          ctx,
          deadlineAt,
        );
        const year = toYear(first.items[0]?.year);
        const month = toIdentityText(first.items[0]?.month);
        if (year === undefined || !month) {
          throw serviceUnavailable('UNHCR returned no nowcast snapshot.');
        }
        return { year, month };
      }),
    );
  }

  /** All of UNHCR's footnotes, parsed and cached 24 h. */
  footnotes(ctx: Context, options?: CallOptions): Promise<Footnote[]> {
    return this.run(ctx, options, (deadlineAt) =>
      this.reference('footnotes', ctx, deadlineAt, async (refreshDeadlineAt) => {
        const items = await this.referenceItems('footnotes', {}, ctx, refreshDeadlineAt);
        return items.map(toFootnote).filter((note) => note.text !== '');
      }),
    );
  }

  /** Year-end population stocks (plus within-year returns) for a validated query. */
  population(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<PopulationRow>> {
    return this.dataset('population', POPULATION_FIELDS, query, ctx, options);
  }

  /**
   * Year-end stocks by population type, sex, and age band. Always sent with
   * `ptype_show=true`: without it, upstream's `total` sums every type, host
   * community included, and the type is lost.
   */
  demographics(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<DemographicsRow>> {
    return this.dataset('demographics', DEMOGRAPHICS_FIELDS, query, ctx, options, {
      params: { ptypeShow: true },
      codes: (raw) => ({ population_type: toIdentityText(raw.pop_type) }),
    });
  }

  /** Asylum applications lodged per year, one row per authority × stage × level × unit. */
  asylumApplications(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<AsylumApplicationRow>> {
    return this.dataset('asylum-applications', APPLICATION_FIELDS, query, ctx, options, {
      codes: (raw) => ({ ...toAsylumCodes(raw, 'app_pc'), stage: toIdentityText(raw.app_type) }),
    });
  }

  /** Asylum decisions per year by outcome, one row per authority × level × unit. */
  asylumDecisions(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<AsylumDecisionRow>> {
    return this.dataset('asylum-decisions', DECISION_FIELDS, query, ctx, options, {
      codes: (raw) => toAsylumCodes(raw, 'dec_pc'),
    });
  }

  /** Durable solutions (returns, resettlement, naturalisation) for a validated query. */
  solutions(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<SolutionsRow>> {
    return this.dataset('solutions', SOLUTIONS_FIELDS, query, ctx, options);
  }

  /** Palestine refugees registered with UNRWA, same scope and window. */
  unrwa(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<CompanionRow>> {
    return this.dataset('unrwa', ['total'], query, ctx, options);
  }

  /** IDMC's conflict-IDP estimate, same scope and window. */
  idmc(
    query: DatasetQuery,
    ctx: Context,
    options?: CallOptions,
  ): Promise<DatasetResult<CompanionRow>> {
    return this.dataset('idmc', ['total'], query, ctx, options);
  }

  /**
   * The current-year nowcast by asylum scope: listed codes, every asylum
   * country, or the world total. Independent of any year window. Counts the
   * values reported as null and the rows left out for want of a year, so the
   * tool can say so.
   */
  nowcast(asylum: DimensionScope, ctx: Context, options?: CallOptions): Promise<NowcastResult> {
    return this.run(ctx, options, async (deadlineAt) => {
      const { items } = await this.walk(
        'nowcasting',
        dimensionParams('coa', asylum),
        ctx,
        deadlineAt,
        { waiterSignal: ctx.signal },
      );
      const tally: ValueTally = { unexpected: 0 };
      const rows = items.flatMap((raw) => toNowcastRow(raw, tally) ?? []);
      this.warnUnexpected('nowcasting', tally, ctx);
      return {
        rows,
        unexpectedValues: tally.unexpected,
        skippedRows: items.length - rows.length,
      };
    });
  }

  /**
   * Walk one dataset endpoint for a validated query and normalize its rows,
   * counting the values reported as null and the rows left out for want of a
   * year. `shape.codes` carries a dataset's code columns (population type,
   * asylum procedure codes) onto each row; `shape.params` adds endpoint-only
   * parameters the builder allowlists.
   */
  private dataset<F extends string, C extends object = Record<never, never>>(
    endpoint: Endpoint,
    fields: readonly F[],
    query: DatasetQuery,
    ctx: Context,
    options: CallOptions | undefined,
    shape: { codes?: (raw: RawRow) => C; params?: RequestParams } = {},
  ): Promise<DatasetResult<DataRow<F> & C>> {
    return this.run(ctx, options, async (deadlineAt) => {
      const params = { ...queryParams(query), ...shape.params };
      const { items, complete } = await this.walk(endpoint, params, ctx, deadlineAt, {
        waiterSignal: ctx.signal,
      });
      const tally: ValueTally = { unexpected: 0 };
      const rows: (DataRow<F> & C)[] = [];
      for (const raw of items) {
        const row = toDataRow(raw, fields, tally);
        if (row) rows.push({ ...row, ...shape.codes?.(raw) } as DataRow<F> & C);
      }
      this.warnUnexpected(endpoint, tally, ctx);
      return {
        rows,
        complete,
        unexpectedValues: tally.unexpected,
        skippedRows: items.length - rows.length,
      };
    });
  }

  private warnUnexpected(endpoint: Endpoint, tally: ValueTally, ctx: Context): void {
    if (tally.unexpected === 0) return;
    ctx.log.warning('UNHCR returned values that are neither numbers nor "-"; reported as null', {
      endpoint,
      count: tally.unexpected,
    });
  }

  /**
   * Run one public method's upstream work for a caller: charge it to the
   * call's deadline, race it against the caller's cancellation (the shared
   * work itself never carries a caller's signal), and map queue and deadline
   * failures onto this caller's error contract.
   */
  private async run<T>(
    ctx: Context,
    options: CallOptions | undefined,
    work: (deadlineAt: number) => Promise<T>,
  ): Promise<T> {
    const deadlineAt = this.deadlineFor(ctx, options);
    try {
      if (deadlineAt <= Date.now() && !ctx.signal.aborted) throw loadDeadline();
      return await raceSignal(work(deadlineAt), ctx.signal);
    } catch (error) {
      throw this.toCallerError(error, ctx);
    }
  }

  /** The call's absolute deadline: 45 s from its first upstream work, shared by later methods. */
  private deadlineFor(ctx: Context, options: CallOptions | undefined): number {
    if (options?.deadlineMs !== undefined) return Date.now() + options.deadlineMs;
    let deadlineAt = this.callDeadlines.get(ctx);
    if (deadlineAt === undefined) {
      deadlineAt = Date.now() + CALL_BUDGET_MS;
      this.callDeadlines.set(ctx, deadlineAt);
    }
    return deadlineAt;
  }

  /**
   * A pacer shed or an exhausted upstream 429 becomes `upstream_busy` with a
   * `retryAfter` and the calling tool's recovery; a spent deadline becomes a
   * `Timeout` that says whether an identical retry resumes from cached pages
   * and how to need fewer requests. Done here, outside
   * `withRetry`: inside it, rewrapping would erase the `pacer_shed` reason
   * that makes the retry loop fail fast instead of sleeping past the deadline.
   */
  private toCallerError(error: unknown, ctx: Context): unknown {
    if (ctx.signal.aborted || !(error instanceof McpError)) return error;
    const data = error.data ?? {};
    if (error.code === JsonRpcErrorCode.RateLimited) {
      const retryAfter = retryAfterSeconds(data.retryAfter);
      const message =
        data.reason === 'pacer_shed'
          ? "This server's UNHCR request queue cannot start this call's requests within its time budget."
          : 'UNHCR is rate-limiting requests from this server.';
      return rateLimited(
        `${message} Retry in ${retryAfter} s.`,
        {
          reason: 'upstream_busy',
          retryable: true,
          retryAfter,
          ...ctx.recoveryFor('upstream_busy'),
        },
        { cause: error },
      );
    }
    if (isLoadDeadline(error)) {
      return deadlineExceeded(this.config.cacheMaxBytes, error);
    }
    if (
      error.code === JsonRpcErrorCode.ServiceUnavailable &&
      data.retryable !== false &&
      data.operation === 'UNHCR API request' &&
      typeof data.retryAttempts === 'number'
    ) {
      return serviceUnavailable(
        error.message,
        { ...data, retryable: true, recovery: { hint: OUTAGE_HINT } },
        { cause: error },
      );
    }
    return error;
  }

  /** Keep successful reference values separate from in-flight refreshes and their failures. */
  private async reference<T>(
    key: ReferenceKey,
    ctx: Context,
    deadlineAt: number,
    load: (deadlineAt: number) => Promise<T>,
  ): Promise<T> {
    const hit = this.references.get(key);
    const now = this.now();
    if (hit && now - hit.storedAt < REFERENCE_TTL_MS) return hit.value as T;

    const staleKey = Object.hasOwn(STALE_REFERENCES, key) ? (key as StaleReference) : undefined;
    const fallback =
      staleKey && hit && now - hit.storedAt <= REFERENCE_MAX_AGE_MS ? hit : undefined;
    const result =
      fallback?.retryAt !== undefined && now < fallback.retryAt
        ? { value: fallback.value, staleAgeMs: now - fallback.storedAt }
        : await this.referenceLoads.get(
            key,
            deadlineAt,
            async () => {
              const startedAt = Date.now();
              // Reserve time for the caller's other work, even when a warm refresh stalls.
              const refreshDeadlineAt = fallback
                ? startedAt +
                  Math.min(REFERENCE_REFRESH_BUDGET_MS, Math.floor((deadlineAt - startedAt) / 2))
                : deadlineAt;
              try {
                const value = await load(refreshDeadlineAt);
                this.references.set(key, { storedAt: this.now(), value });
                return { value };
              } catch (error) {
                const failedAt = this.now();
                if (
                  !fallback ||
                  Date.now() >= deadlineAt ||
                  failedAt - fallback.storedAt > REFERENCE_MAX_AGE_MS ||
                  !isTransientRefreshFailure(error)
                )
                  throw error;

                const upstreamDelayMs = retryAfterSeconds(error.data?.retryAfter) * 1_000;
                fallback.retryAt =
                  failedAt + Math.max(REFERENCE_REFRESH_COOLDOWN_MS, upstreamDelayMs);
                return { value: fallback.value, staleAgeMs: failedAt - fallback.storedAt };
              }
            },
            ctx.signal,
          );
    if (staleKey && result.staleAgeMs !== undefined && !ctx.signal.aborted) {
      let stale = referenceStaleness.get(ctx);
      if (!stale) {
        stale = new Map();
        referenceStaleness.set(ctx, stale);
      }
      stale.set(staleKey, result.staleAgeMs);
    }
    return result.value as T;
  }

  /** Reference lists used for validation and caveats must include every page. */
  private async referenceItems(
    endpoint: 'countries' | 'regions' | 'footnotes',
    params: RequestParams,
    ctx: Context,
    deadlineAt: number,
  ): Promise<RawRow[]> {
    const referenceRow =
      endpoint === 'footnotes'
        ? (row: RawRow) => toFootnote(row).text !== ''
        : endpoint === 'regions'
          ? (row: RawRow) => toBureau(row) !== undefined
          : params.unhcrRegion !== undefined
            ? (row: RawRow) => toIdentityText(row.iso) !== null
            : (row: RawRow) => toCountry(row) !== undefined;
    const { complete, items } = await this.walk(endpoint, params, ctx, deadlineAt, {
      referenceRow,
    });
    if (!complete) {
      throw serviceUnavailable('The UNHCR reference list exceeds this server’s row cap.', {
        retryable: false,
      });
    }
    return items;
  }

  /**
   * Fetch page 1, read `maxPages`, then fetch the remaining pages up to the row
   * cap in parallel (the pacer bounds concurrency). Rows arrive year-ascending
   * and pages are stable, so concatenation preserves order.
   */
  private async walk(
    endpoint: Endpoint,
    params: RequestParams,
    ctx: Context,
    deadlineAt: number,
    {
      referenceRow,
      waiterSignal,
    }: { referenceRow?: ReferencePage['accepts']; waiterSignal?: AbortSignal } = {},
  ): Promise<{ complete: boolean; items: RawRow[] }> {
    const fetchPage = (index: number, maxPages?: number) =>
      this.page(
        buildUrl(endpoint, { ...params, limit: PAGE_SIZE, page: index }),
        ctx,
        deadlineAt,
        referenceRow
          ? { accepts: referenceRow, index, ...(maxPages !== undefined && { maxPages }) }
          : undefined,
        waiterSignal,
      );
    const first = await fetchPage(1);
    waiterSignal?.throwIfAborted();
    const pageCap = Math.ceil(this.config.maxRows / PAGE_SIZE);
    const lastPage = Math.min(first.maxPages, pageCap);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, lastPage - 1) }, (_, i) => fetchPage(i + 2, first.maxPages)),
    );
    if (referenceRow && rest.some(({ maxPages }) => maxPages !== first.maxPages)) {
      throw serviceUnavailable('UNHCR API returned inconsistent pagination for a reference list.');
    }
    const items = [first, ...rest].flatMap((envelope) => envelope.items);
    return {
      items: items.slice(0, this.config.maxRows),
      complete: first.maxPages <= pageCap && items.length <= this.config.maxRows,
    };
  }

  /** One page: from the cache, from an identical request already in flight, or fetched. */
  private page(
    url: string,
    ctx: Context,
    deadlineAt: number,
    reference?: ReferencePage,
    waiterSignal?: AbortSignal,
  ): Promise<Envelope> {
    const cached = reference ? undefined : this.cache.get(url);
    if (cached !== undefined) return Promise.resolve(parseEnvelope(cached));
    return this.inflight.get(
      url,
      deadlineAt,
      () => this.load(url, ctx, deadlineAt, reference),
      waiterSignal,
    );
  }

  /**
   * Fetch, parse, and validate one page under `withRetry`, each attempt queued
   * through the pacer. Runs under the first caller's deadline and never under
   * any caller's signal, so one caller cancelling cannot fail another.
   */
  private load(
    url: string,
    ctx: Context,
    deadlineAt: number,
    reference: ReferencePage | undefined,
  ): Promise<Envelope> {
    const budget = deadlineAt - Date.now();
    if (budget <= 0) return Promise.reject(loadDeadline());
    return withRetry(
      async ({ signal }) => {
        const body = await this.pacer.run(() => this.fetchBody(url, signal, deadlineAt), {
          signal,
          maxWaitMs: Math.max(0, deadlineAt - Date.now()),
        });
        const envelope = parseEnvelope(body, reference);
        // A failed refresh must not pin partial reference pages across cooldowns.
        if (!reference) this.cache.set(url, body);
        return envelope;
      },
      {
        operation: 'UNHCR API request',
        context: ctx,
        maxRetries: 2,
        baseDelayMs: 1000,
        deadlineMs: budget,
      },
    );
  }

  /**
   * One HTTP attempt: a per-attempt timeout (30 s, capped at the call's
   * remaining budget) composed with the retry loop's signal, covering the body
   * read too. Every non-2xx maps through `httpErrorFromResponse` without its
   * body, since UNHCR's error bodies are HTML pages; a network failure is
   * `ServiceUnavailable`.
   */
  private async fetchBody(url: string, attemptSignal: AbortSignal, deadlineAt: number) {
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now()));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.any([attemptSignal, timeoutSignal]),
      });
      if (!response.ok) {
        throw await httpErrorFromResponse(response, { service: 'UNHCR', captureBody: false });
      }
      return await response.text();
    } catch (error) {
      if (error instanceof McpError || attemptSignal.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw timeout(`UNHCR did not respond within ${Math.round(timeoutMs / 1000)} s.`);
      }
      throw serviceUnavailable(
        `UNHCR API request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    }
  }
}

let _service: UnhcrApiService | undefined;

/** Construct the service during `setup()`; returns the instance for tests. */
export function initUnhcrService(options: UnhcrServiceOptions): UnhcrApiService {
  _service?.dispose();
  _service = new UnhcrApiService(options);
  return _service;
}

/** The initialized service. */
export function getUnhcrService(): UnhcrApiService {
  if (!_service) {
    throw new Error('UnhcrApiService not initialized — call initUnhcrService() in setup()');
  }
  return _service;
}

/** Stop the service's pacer — wired through `createApp({ teardown })`. */
export function disposeUnhcrService(): void {
  _service?.dispose();
  _service = undefined;
}
