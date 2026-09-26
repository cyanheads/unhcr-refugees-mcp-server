/**
 * @fileoverview In-memory stand-in for the UNHCR Refugee Statistics API behind
 * the framework's strict fetch mock, so tests drive `UnhcrApiService` through
 * its injected `fetch` with no network. The fake answers the way the design's
 * API Reference records the upstream behaving: an unfiltered data request
 * returns world totals, `coo`/`coa` lists return one row per listed code
 * (matched on ISO3 only when `cf_type=ISO`), `*_all` returns one row per
 * country, a year window applies only when both bounds are sent, rows arrive
 * year-ascending, `limit`/`page` slice them, an empty result is `maxPages: 0`,
 * and an unknown path is a 404 HTML page. `/demographics/` without
 * `ptype_show=true` sums every population type into one row per key and drops
 * the type, and the asylum endpoints and solutions carry a `total` object of
 * whole-query column sums (cases added to persons, as UNHCR's does). Per-test
 * `intercept` routes answer ahead of the engine to inject faults.
 * @module tests/helpers/fake-unhcr
 */

import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import {
  ASYLUM_APPLICATION_ROWS,
  ASYLUM_DECISION_ROWS,
  COUNTRY_ROWS,
  DEMOGRAPHICS_ROWS,
  envelope,
  FOOTNOTE_ROWS,
  IDMC_ROWS,
  NOWCAST_ROWS,
  POPULATION_ROWS,
  type RawRow,
  REGION_MEMBER_ROWS,
  REGION_ROWS,
  SOLUTIONS_ROWS,
  UNRWA_ROWS,
} from '../fixtures/unhcr.js';

export const UNHCR_ORIGIN = 'https://api.unhcr.org';
const API_PREFIX = '/population/v1/';

/** Endpoints whose rows carry origin/asylum dimensions. */
const DIMENSIONED = new Set([
  'asylum-applications',
  'asylum-decisions',
  'demographics',
  'idmc',
  'nowcasting',
  'population',
  'solutions',
  'unrwa',
]);

/** Tables the fake serves, keyed by endpoint path segment. */
export type FakeTables = Record<string, RawRow[]>;

/** A fault or override answered before the engine. */
export interface FakeIntercept {
  /** Endpoint path segment (`countries`, `population`, …). */
  endpoint: string;
  /** Only intercept requests whose query satisfies this. */
  matches?: (params: URLSearchParams) => boolean;
  /** Serve once, then fall through to the engine. */
  once?: boolean;
  /** A factory, so every intercepted request gets a fresh body. */
  respond: (request: Request) => Promise<Response> | Response;
}

export interface FakeUnhcrOptions {
  /** Serve an endpoint with at most this many rows per page, to simulate a multi-page result. */
  pageSize?: Record<string, number>;
  /** Replace or add tables; the recorded fixtures are the default. */
  tables?: FakeTables;
}

export interface FakeUnhcr {
  /** Captured requests, in call order. */
  readonly calls: FetchMockHarness['calls'];
  /** The injectable fetch. */
  readonly fetch: typeof fetch;
  /** Answer matching requests ahead of the engine. */
  intercept(intercept: FakeIntercept): void;
  /** Parsed URLs of every request so far. */
  urls(): URL[];
  /** Parsed URLs of requests to one endpoint. */
  urlsFor(endpoint: string): URL[];
}

export const DEFAULT_TABLES: FakeTables = {
  'asylum-applications': ASYLUM_APPLICATION_ROWS,
  'asylum-decisions': ASYLUM_DECISION_ROWS,
  countries: COUNTRY_ROWS,
  demographics: DEMOGRAPHICS_ROWS,
  footnotes: FOOTNOTE_ROWS,
  idmc: IDMC_ROWS,
  nowcasting: NOWCAST_ROWS,
  population: POPULATION_ROWS,
  regions: REGION_ROWS,
  solutions: SOLUTIONS_ROWS,
  unrwa: UNRWA_ROWS,
};

/** Columns UNHCR sums into the envelope's `total` object, per endpoint that has one. */
const TOTALLED: Record<string, readonly string[]> = {
  'asylum-applications': ['applied'],
  'asylum-decisions': ['dec_recognized', 'dec_other', 'dec_rejected', 'dec_closed', 'dec_total'],
  solutions: ['returned_refugees', 'resettlement', 'naturalisation', 'returned_idps'],
};

/** Count columns of a `/demographics/` row, the row total included. */
const DEMOGRAPHIC_COUNTS = [
  ...['f', 'm'].flatMap((sex) =>
    ['0_4', '5_11', '12_17', '18_59', '60', 'other', 'total'].map((band) => `${sex}_${band}`),
  ),
  'total',
];

/** A cell's numeric value for summing; `"-"` and a missing cell add nothing. */
const numeric = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Sum per-type demographics rows into one row per year and country pair, as
 * UNHCR answers a request without `ptype_show=true`. The input is year-sorted,
 * so the output stays year-ascending.
 */
function sumPopulationTypes(rows: RawRow[]): RawRow[] {
  const byKey = new Map<string, RawRow>();
  for (const { pop_type: _type, ...row } of rows) {
    const key = `${row.year}|${row.coo_iso}|${row.coa_iso}`;
    const sum = byKey.get(key);
    if (!sum) {
      byKey.set(key, {
        ...row,
        ...Object.fromEntries(DEMOGRAPHIC_COUNTS.map((column) => [column, numeric(row[column])])),
      });
      continue;
    }
    for (const column of DEMOGRAPHIC_COUNTS) {
      sum[column] = numeric(sum[column]) + numeric(row[column]);
    }
  }
  return [...byKey.values()];
}

/** Endpoint segment of an API URL (`population` for `/population/v1/population/`). */
export const endpointOf = (url: URL): string =>
  url.pathname.slice(API_PREFIX.length).replace(/\/$/, '');

/** A 404 like the upstream's: an HTML page, not JSON. */
export const htmlNotFound = (): Response =>
  new Response('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });

/** A 200 whose body is an HTML page, as a misbehaving edge would serve. */
export const htmlOk = (): Response =>
  new Response('<!DOCTYPE html><html><body>Maintenance</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

/** Keep rows matching one dimension of the request. */
function filterDimension(
  rows: RawRow[],
  params: URLSearchParams,
  dimension: 'coa' | 'coo',
): RawRow[] {
  const key = params.get('cf_type')?.toUpperCase() === 'ISO' ? `${dimension}_iso` : dimension;
  const list = params.get(dimension);
  if (list !== null) {
    const codes = new Set(list.split(','));
    return rows.filter((row) => codes.has(String(row[key])));
  }
  if (params.get(`${dimension}_all`) === 'true') return rows.filter((row) => row[key] !== '-');
  return rows.filter((row) => row[key] === '-');
}

function serve(url: URL, tables: FakeTables, pageSize: Record<string, number>): Response {
  const endpoint = endpointOf(url);
  const params = url.searchParams;
  const table = tables[endpoint];
  if (!table) return htmlNotFound();

  let rows = table;
  if (endpoint === 'countries' && params.has('unhcr_region')) {
    rows = REGION_MEMBER_ROWS[Number(params.get('unhcr_region'))] ?? [];
  }
  if (DIMENSIONED.has(endpoint)) {
    rows = filterDimension(filterDimension(rows, params, 'coo'), params, 'coa');
  }
  const yearFrom = params.get('yearFrom');
  const yearTo = params.get('yearTo');
  if (yearFrom !== null && yearTo !== null) {
    rows = rows.filter(
      (row) => Number(row.year) >= Number(yearFrom) && Number(row.year) <= Number(yearTo),
    );
  }
  if (DIMENSIONED.has(endpoint)) {
    rows = [...rows].sort((a, b) => Number(a.year) - Number(b.year));
  }
  if (endpoint === 'demographics' && params.get('ptype_show') !== 'true') {
    rows = sumPopulationTypes(rows);
  }

  const limit = Math.min(Number(params.get('limit') ?? 10_000), pageSize[endpoint] ?? Infinity);
  const page = Number(params.get('page') ?? 1);
  const maxPages = Math.ceil(rows.length / limit);
  const items = rows.slice((page - 1) * limit, page * limit);
  if (endpoint === 'footnotes') return Response.json({ page, maxPages, items });
  const totalled = TOTALLED[endpoint];
  const total =
    totalled &&
    Object.fromEntries(
      totalled.map((column) => [column, rows.reduce((sum, row) => sum + numeric(row[column]), 0)]),
    );
  return Response.json(envelope(items, { page, maxPages, ...(total && { total }) }));
}

/** Build the fake upstream. */
export function createFakeUnhcr(options: FakeUnhcrOptions = {}): FakeUnhcr {
  const tables = { ...DEFAULT_TABLES, ...options.tables };
  const pageSize = options.pageSize ?? {};
  const intercepts: FakeIntercept[] = [];

  const harness = createFetchMock([
    {
      method: 'GET',
      match: (request) => {
        const url = new URL(request.url);
        return url.origin === UNHCR_ORIGIN && url.pathname.startsWith(API_PREFIX);
      },
      respond: (request) => {
        const url = new URL(request.url);
        const endpoint = endpointOf(url);
        const hit = intercepts.find(
          (candidate) =>
            candidate.endpoint === endpoint && (candidate.matches?.(url.searchParams) ?? true),
        );
        if (hit) {
          if (hit.once) intercepts.splice(intercepts.indexOf(hit), 1);
          return hit.respond(request);
        }
        return serve(url, tables, pageSize);
      },
    },
  ]);

  const urls = () => harness.calls.map((call) => new URL(call.request.url));
  return {
    calls: harness.calls,
    fetch: harness.fetch,
    intercept: (intercept) => intercepts.push(intercept),
    urls,
    urlsFor: (endpoint) => urls().filter((url) => endpointOf(url) === endpoint),
  };
}

/** A responder that never answers until the request is aborted, then rejects with its reason. */
export const hangUntilAborted = (request: Request): Promise<Response> =>
  new Promise<Response>((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
