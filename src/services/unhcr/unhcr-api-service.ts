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
import { ResponseCache } from './response-cache.js';
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
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const DEADLINE_HINT =
  'Narrow the year window or drop expand so the call needs fewer upstream requests, then retry.';

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

/**
 * Validate a response body as the page envelope. A 200 that is not JSON, or
 * JSON without an `items` array, is a transient upstream fault
 * (`ServiceUnavailable`), not a serialization bug on this side.
 */
function parseEnvelope(body: string): Envelope {
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
  return {
    items: parsed.items.filter(isRecord),
    maxPages: Number.isInteger(maxPages) && maxPages >= 0 ? maxPages : 1,
  };
}

/** Race a shared promise against one caller's cancellation. */
function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
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

function deadlineExceeded(cause?: unknown): McpError {
  return timeout(
    `UNHCR did not answer within this call's ${CALL_BUDGET_MS / 1000} s budget. ${DEADLINE_HINT}`,
    { recovery: { hint: DEADLINE_HINT } },
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
  storedAt: number;
  value: Promise<unknown>;
}

export class UnhcrApiService {
  private readonly cache: ResponseCache;
  private readonly callDeadlines = new WeakMap<object, number>();
  private readonly config: UnhcrServiceConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly inflight = new Map<string, Promise<Envelope>>();
  private readonly now: () => number;
  private readonly pacer: Pacer;
  private readonly references = new Map<string, ReferenceEntry>();

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
      this.reference('countries', async () => {
        const { items } = await this.walk('countries', {}, ctx, deadlineAt);
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
      this.reference('regions', async () => {
        const { items } = await this.walk('regions', {}, ctx, deadlineAt);
        const regions = await Promise.all(
          items.flatMap((raw) => {
            const id = Number(raw.id);
            const name = toIdentityText(raw.name);
            if (!Number.isInteger(id) || !name) return [];
            return [
              this.walk('countries', { unhcrRegion: id }, ctx, deadlineAt).then(
                ({ items: members }): UnhcrRegion => ({
                  id,
                  name,
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
      this.reference(`coverage/${dataset}`, async () => {
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
      this.reference('nowcast-period', async () => {
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

  /** All of UNHCR's footnotes (658 at last count), parsed and cached 24 h. */
  footnotes(ctx: Context, options?: CallOptions): Promise<Footnote[]> {
    return this.run(ctx, options, (deadlineAt) =>
      this.reference('footnotes', async () => {
        const { items } = await this.walk('footnotes', {}, ctx, deadlineAt);
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
      const { items, complete } = await this.walk(endpoint, params, ctx, deadlineAt);
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
   * `Timeout` that says how to need fewer requests. Done here, outside
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
    if (error.code === JsonRpcErrorCode.Timeout && data.reason === 'retry_deadline_exceeded') {
      return deadlineExceeded(error);
    }
    return error;
  }

  /** A promise cached for 24 h, shared by concurrent callers, dropped on failure. */
  private reference<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.references.get(key);
    if (hit && this.now() - hit.storedAt < REFERENCE_TTL_MS) return hit.value as Promise<T>;
    const value = load();
    this.references.set(key, { storedAt: this.now(), value });
    value.catch(() => {
      if (this.references.get(key)?.value === value) this.references.delete(key);
    });
    return value;
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
  ): Promise<{ complete: boolean; items: RawRow[] }> {
    const url = (page: number) => buildUrl(endpoint, { ...params, limit: PAGE_SIZE, page });
    const first = await this.page(url(1), ctx, deadlineAt);
    const pageCap = Math.ceil(this.config.maxRows / PAGE_SIZE);
    const lastPage = Math.min(first.maxPages, pageCap);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, lastPage - 1) }, (_, i) =>
        this.page(url(i + 2), ctx, deadlineAt),
      ),
    );
    const items = [first, ...rest].flatMap((envelope) => envelope.items);
    return {
      items: items.slice(0, this.config.maxRows),
      complete: first.maxPages <= pageCap && items.length <= this.config.maxRows,
    };
  }

  /** One page: from the cache, from an identical request already in flight, or fetched. */
  private page(url: string, ctx: Context, deadlineAt: number): Promise<Envelope> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return Promise.resolve(parseEnvelope(cached));
    let shared = this.inflight.get(url);
    if (!shared) {
      shared = this.load(url, ctx, deadlineAt).finally(() => this.inflight.delete(url));
      this.inflight.set(url, shared);
    }
    return shared;
  }

  /**
   * Fetch, parse, and validate one page under `withRetry`, each attempt queued
   * through the pacer. Runs under the first caller's deadline and never under
   * any caller's signal, so one caller cancelling cannot fail another.
   */
  private load(url: string, ctx: Context, deadlineAt: number): Promise<Envelope> {
    const budget = deadlineAt - Date.now();
    if (budget <= 0) return Promise.reject(deadlineExceeded());
    return withRetry(
      async ({ signal }) => {
        const body = await this.pacer.run(() => this.fetchBody(url, signal, deadlineAt), {
          signal,
          maxWaitMs: Math.max(0, deadlineAt - Date.now()),
        });
        const envelope = parseEnvelope(body);
        this.cache.set(url, body);
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
   * remaining budget) composed with the retry loop's signal, cleared once the
   * body is read. Every non-2xx maps through `httpErrorFromResponse` without
   * its body, since UNHCR's error bodies are HTML pages; a network failure is
   * `ServiceUnavailable`.
   */
  private async fetchBody(url: string, attemptSignal: AbortSignal, deadlineAt: number) {
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.any([attemptSignal, controller.signal]),
      });
      if (!response.ok) {
        throw await httpErrorFromResponse(response, { service: 'UNHCR', captureBody: false });
      }
      return await response.text();
    } catch (error) {
      if (error instanceof McpError || attemptSignal.aborted) throw error;
      if (controller.signal.aborted) {
        throw timeout(`UNHCR did not respond within ${Math.round(timeoutMs / 1000)} s.`);
      }
      throw serviceUnavailable(
        `UNHCR API request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
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
