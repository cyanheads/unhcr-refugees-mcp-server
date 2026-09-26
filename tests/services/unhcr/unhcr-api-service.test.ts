/**
 * @fileoverview Tests for `UnhcrApiService` through its constructor seams: the
 * injected `fetch` (a fake UNHCR upstream over the framework's strict fetch
 * mock), the plain-object config, and the `now` clock. Covers the request
 * builder, envelope validation, retry, the page walk and row cap, pacing and
 * the `upstream_busy` rewrap, the call deadline, caching, single-flight, the
 * demographics and asylum dataset methods (`ptype_show`, the procedure-code
 * columns, the ignored envelope `total`), and the reference data (countries,
 * regions, coverage, nowcast month, footnotes).
 * @module tests/services/unhcr/unhcr-api-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasetQuery } from '@/services/unhcr/types.js';
import {
  buildUrl,
  disposeUnhcrService,
  getUnhcrService,
  initUnhcrService,
  UnhcrApiService,
  type UnhcrServiceConfig,
} from '@/services/unhcr/unhcr-api-service.js';
import {
  ASYLUM_APPLICATION_ROWS,
  applicationRow,
  envelope,
  POPULATION_ROWS,
  populationRow,
} from '../../fixtures/unhcr.js';
import {
  createFakeUnhcr,
  type FakeUnhcr,
  type FakeUnhcrOptions,
  hangUntilAborted,
  htmlNotFound,
  htmlOk,
} from '../../helpers/fake-unhcr.js';
import { TEST_SERVICE_CONFIG } from '../../helpers/services.js';

const BASE = 'https://api.unhcr.org/population/v1';

const services: UnhcrApiService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  disposeUnhcrService();
});

/** A service over a fresh fake upstream. */
function setup(
  options: FakeUnhcrOptions & { config?: Partial<UnhcrServiceConfig>; now?: () => number } = {},
): { fake: FakeUnhcr; service: UnhcrApiService } {
  const fake = createFakeUnhcr(options);
  const service = new UnhcrApiService({
    fetch: fake.fetch,
    config: { ...TEST_SERVICE_CONFIG, ...options.config },
    ...(options.now && { now: options.now }),
  });
  services.push(service);
  return { fake, service };
}

const syrQuery: DatasetQuery = {
  origin: { mode: 'listed', codes: ['SYR'] },
  asylum: { mode: 'summed', codes: [] },
  yearFrom: 2023,
  yearTo: 2025,
};

/** Resolve a promise's rejection, failing the test when it resolves instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected a rejection');
}

describe('buildUrl', () => {
  it('emits allowlisted parameters in a fixed order, with cf_type=ISO always present', () => {
    expect(
      buildUrl('population', {
        page: 2,
        limit: 10_000,
        yearTo: 2025,
        yearFrom: 2020,
        coa: ['DEU'],
        coo: ['SYR', 'AFG'],
      }),
    ).toBe(
      `${BASE}/population/?coo=SYR,AFG&coa=DEU&yearFrom=2020&yearTo=2025&cf_type=ISO&limit=10000&page=2`,
    );
  });

  it('adds cf_type=ISO to parameterless reference requests too', () => {
    expect(buildUrl('countries')).toBe(`${BASE}/countries/?cf_type=ISO`);
    expect(buildUrl('countries', { unhcrRegion: 7, limit: 10_000, page: 1 })).toBe(
      `${BASE}/countries/?unhcr_region=7&cf_type=ISO&limit=10000&page=1`,
    );
  });

  it('expresses expand as coo_all / coa_all', () => {
    expect(
      buildUrl('solutions', { cooAll: true, coaAll: true, yearFrom: 2024, yearTo: 2024 }),
    ).toBe(`${BASE}/solutions/?coo_all=true&coa_all=true&yearFrom=2024&yearTo=2024&cf_type=ISO`);
    expect(buildUrl('population', { coo: [], cooAll: true })).toBe(
      `${BASE}/population/?coo_all=true&cf_type=ISO`,
    );
  });

  it('refuses a lone year bound, which UNHCR would silently ignore', () => {
    expect(() => buildUrl('population', { yearFrom: 2020 })).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.InternalError }),
    );
    expect(() => buildUrl('population', { yearTo: 2020 })).toThrow(McpError);
  });

  it('refuses a code list and *_all on one dimension, since *_all overrides the list', () => {
    expect(() => buildUrl('population', { coo: ['SYR'], cooAll: true })).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.InternalError }),
    );
    expect(() => buildUrl('population', { coa: ['DEU'], coaAll: true })).toThrow(McpError);
  });
});

describe('dataset methods', () => {
  it('fetches one page with the full scope and normalizes the rows', async () => {
    const { fake, service } = setup();
    const result = await service.population(syrQuery, createMockContext());

    expect(result.complete).toBe(true);
    expect(result.unexpectedValues).toBe(0);
    expect(result.rows.map((row) => row.year)).toEqual([2023, 2024, 2025]);
    expect(result.rows[0]).toMatchObject({
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: null,
      asylum_name: null,
      refugees: 6355788,
      stateless: 0,
      oip: null,
    });
    expect(fake.urls().map(String)).toEqual([
      `${BASE}/population/?coo=SYR&yearFrom=2023&yearTo=2025&cf_type=ISO&limit=10000&page=1`,
    ]);
  });

  it('identifies itself and asks for JSON', async () => {
    const { fake, service } = setup();
    await service.population(syrQuery, createMockContext());
    const headers = fake.calls[0]?.request.headers;
    expect(headers?.get('accept')).toBe('application/json');
    expect(headers?.get('user-agent')).toContain('unhcr-refugees-mcp-server');
  });

  it('sends coo_all / coa_all for expanded dimensions', async () => {
    const { fake, service } = setup();
    const result = await service.population(
      { ...syrQuery, asylum: { mode: 'each', codes: [] }, yearFrom: 2025, yearTo: 2025 },
      createMockContext(),
    );
    expect(result.rows.map((row) => row.asylum_iso3).sort()).toEqual([
      'DEU',
      'JOR',
      'LBN',
      'SYR',
      'TUR',
    ]);
    expect(fake.urls()[0]?.searchParams.get('coa_all')).toBe('true');
  });

  it('serves solutions and both companion series with the same scope', async () => {
    const { fake, service } = setup();
    const ctx = createMockContext();
    const [solutions, idmc, unrwa] = await Promise.all([
      service.solutions(syrQuery, ctx),
      service.idmc(syrQuery, ctx),
      service.unrwa(syrQuery, ctx),
    ]);
    expect(solutions.rows[0]).toMatchObject({ year: 2023, resettlement: 33388 });
    expect(idmc.rows.map((row) => row.total)).toEqual([7248000, 7409000, 5964000]);
    expect(unrwa.rows).toEqual([]);
    for (const endpoint of ['solutions', 'idmc', 'unrwa']) {
      expect(fake.urlsFor(endpoint)[0]?.searchParams.get('coo')).toBe('SYR');
    }
  });

  it('reports values that are neither numbers nor "-" as null, counted and logged', async () => {
    const odd = populationRow(2024, 'SYR', null, ['n/a', 1, 2, 3, 4, 5, 6, '-', '1,000']);
    const { service } = setup({ tables: { population: [odd] } });
    const ctx = createMockContext();
    const result = await service.population(syrQuery, ctx);
    expect(result.unexpectedValues).toBe(2);
    expect(result.rows[0]?.refugees).toBeNull();
    expect(result.rows[0]?.hst).toBeNull();
    expect(result.rows[0]?.oip).toBeNull();
    const warnings = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
    expect(warnings).toEqual([
      expect.objectContaining({ data: { endpoint: 'population', count: 2 } }),
    ]);
  });

  it('leaves out a row with no usable year, counting it apart from unexpected values', async () => {
    const { fake, service } = setup();
    // The fake's own year filter would drop a year-less row, so answer the data request directly.
    fake.intercept({
      endpoint: 'population',
      matches: (params) => params.has('yearFrom'),
      respond: () =>
        Response.json(envelope([POPULATION_ROWS[1]!, { ...POPULATION_ROWS[1], year: 'unknown' }])),
    });
    const ctx = createMockContext();
    const result = await service.population(syrQuery, ctx);
    expect(result.rows).toEqual([expect.objectContaining({ year: 2023 })]);
    expect(result.skippedRows).toBe(1);
    expect(result.unexpectedValues).toBe(0);
    const warnings = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
    expect(warnings).toEqual([]);
  });

  it('serves the nowcast for listed, every, and world asylum scopes', async () => {
    const { fake, service } = setup();
    const ctx = createMockContext();
    const listed = await service.nowcast({ mode: 'listed', codes: ['DEU'] }, ctx);
    expect(listed).toEqual({
      rows: [
        {
          asylum_iso3: 'DEU',
          asylum_unhcr_code: 'GFR',
          asylum_name: 'Germany',
          year: 2026,
          month: 'August',
          refugees: 2652400,
          asylum_seekers: 231213,
          source: 'Government',
        },
      ],
      unexpectedValues: 0,
      skippedRows: 0,
    });
    const world = await service.nowcast({ mode: 'summed', codes: [] }, ctx);
    expect(world.rows).toHaveLength(1);
    expect(world.rows[0]?.asylum_iso3).toBeNull();
    const each = await service.nowcast({ mode: 'each', codes: [] }, ctx);
    expect(each.rows.map((row) => row.asylum_iso3)).toEqual(['DEU', 'JOR', 'TUR']);
    for (const url of fake.urlsFor('nowcasting')) {
      expect(url.searchParams.get('cf_type')).toBe('ISO');
      expect(url.searchParams.has('yearFrom')).toBe(false);
    }
  });
});

describe('page walk', () => {
  const pageOf = (page: number) => (params: URLSearchParams) => params.get('page') === String(page);
  const rows = [
    populationRow(2023, 'SYR', null, [1, 1, 1, 1, 1, 1, 1, 1, 1]),
    populationRow(2024, 'SYR', null, [2, 2, 2, 2, 2, 2, 2, 2, 2]),
    populationRow(2025, 'SYR', null, [3, 3, 3, 3, 3, 3, 3, 3, 3]),
  ];

  it('walks a two-page result in order and reports it complete', async () => {
    const { fake, service } = setup();
    fake.intercept({
      endpoint: 'population',
      matches: pageOf(1),
      respond: () => Response.json(envelope(rows.slice(0, 2), { maxPages: 2 })),
    });
    fake.intercept({
      endpoint: 'population',
      matches: pageOf(2),
      respond: () => Response.json(envelope(rows.slice(2), { maxPages: 2, page: 2 })),
    });
    const result = await service.population(syrQuery, createMockContext());
    expect(result.rows.map((row) => row.refugees)).toEqual([1, 2, 3]);
    expect(result.complete).toBe(true);
    expect(fake.urlsFor('population').map((url) => url.searchParams.get('page'))).toEqual([
      '1',
      '2',
    ]);
  });

  it('treats maxPages 0 as an empty, complete result after one request', async () => {
    const { fake, service } = setup();
    const result = await service.population(
      { ...syrQuery, yearFrom: 1951, yearTo: 1960 },
      createMockContext(),
    );
    expect(result).toEqual({ rows: [], complete: true, unexpectedValues: 0, skippedRows: 0 });
    expect(fake.calls).toHaveLength(1);
  });

  it('stops at the page cap and reports complete: false', async () => {
    const { fake, service } = setup({ config: { maxRows: 10_000 } });
    fake.intercept({
      endpoint: 'population',
      respond: () => Response.json(envelope(rows.slice(0, 1), { maxPages: 3 })),
    });
    const result = await service.population(syrQuery, createMockContext());
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(fake.urlsFor('population')).toHaveLength(1);
  });

  it('fetches only as many pages as the row cap allows', async () => {
    const { fake, service } = setup({ config: { maxRows: 20_000 } });
    fake.intercept({
      endpoint: 'population',
      respond: (request) => {
        const page = Number(new URL(request.url).searchParams.get('page'));
        return Response.json(envelope(rows.slice(page - 1, page), { maxPages: 3, page }));
      },
    });
    const result = await service.population(syrQuery, createMockContext());
    expect(result.complete).toBe(false);
    expect(result.rows.map((row) => row.year)).toEqual([2023, 2024]);
    expect(fake.urlsFor('population')).toHaveLength(2);
  });

  it('cuts rows past the cap inside a page and reports complete: false', async () => {
    const { service } = setup({ config: { maxRows: 2 } });
    const result = await service.population(
      { ...syrQuery, asylum: { mode: 'each', codes: [] }, yearFrom: 2025, yearTo: 2025 },
      createMockContext(),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.complete).toBe(false);
  });
});

describe('upstream failures', () => {
  it('retries a 5xx and succeeds on the next attempt', async () => {
    const { fake, service } = setup();
    fake.intercept({
      endpoint: 'population',
      once: true,
      respond: () => new Response('<html>Service Unavailable</html>', { status: 503 }),
    });
    const result = await service.population(syrQuery, createMockContext());
    expect(result.rows).toHaveLength(3);
    expect(fake.urlsFor('population')).toHaveLength(2);
  }, 15_000);

  it('retries a network failure and succeeds on the next attempt', async () => {
    const { fake, service } = setup();
    fake.intercept({
      endpoint: 'population',
      once: true,
      respond: () => Promise.reject(new TypeError('fetch failed')),
    });
    const result = await service.population(syrQuery, createMockContext());
    expect(result.rows).toHaveLength(3);
    expect(fake.urlsFor('population')).toHaveLength(2);
  }, 15_000);

  it('retries JSON without an items array as a transient fault', async () => {
    const { fake, service } = setup();
    fake.intercept({
      endpoint: 'population',
      once: true,
      respond: () => Response.json({ page: 1, maxPages: 1, error: 'upstream hiccup' }),
    });
    const result = await service.population(syrQuery, createMockContext());
    expect(result.rows).toHaveLength(3);
    expect(fake.urlsFor('population')).toHaveLength(2);
  }, 15_000);

  it('fails a persistent HTML 200 as ServiceUnavailable after its retries, not SerializationError', async () => {
    const { fake, service } = setup();
    fake.intercept({ endpoint: 'population', respond: htmlOk });
    const error = await rejectionOf(service.population(syrQuery, createMockContext()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('not JSON');
    expect(fake.urlsFor('population')).toHaveLength(3);
  }, 15_000);

  it('fails a 404 HTML page fast as NotFound, without retrying', async () => {
    const { fake, service } = setup();
    fake.intercept({ endpoint: 'population', respond: htmlNotFound });
    const error = await rejectionOf(service.population(syrQuery, createMockContext()));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(JSON.stringify(error.data)).not.toContain('<html');
    expect(fake.urlsFor('population')).toHaveLength(1);
  });

  it('rewraps an upstream 429 as upstream_busy carrying the Retry-After wait', async () => {
    const { fake, service } = setup();
    fake.intercept({
      endpoint: 'population',
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    });
    const error = await rejectionOf(service.population(syrQuery, createMockContext()));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'upstream_busy', retryable: true, retryAfter: 120 });
    expect(error.message).toContain('rate-limiting');
    expect(fake.urlsFor('population')).toHaveLength(1);
  });
});

describe('pacing and the call deadline', () => {
  it('sheds a request whose queue wait exceeds its deadline as upstream_busy', async () => {
    const { fake, service } = setup({ config: { requestsPerSecond: 1 } });
    await service.countries(createMockContext());

    const error = await rejectionOf(service.footnotes(createMockContext(), { deadlineMs: 200 }));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'upstream_busy', retryable: true });
    expect(error.data?.retryAfter).toBeGreaterThanOrEqual(1);
    expect(error.message).toContain('request queue');
    expect(fake.urlsFor('footnotes')).toHaveLength(0);
  });

  it('carries the calling tool’s recovery hint on upstream_busy', async () => {
    const { fake, service } = setup();
    fake.intercept({
      endpoint: 'countries',
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '90' } }),
    });
    const ctx = createMockContext({
      errors: [
        {
          reason: 'upstream_busy',
          code: JsonRpcErrorCode.RateLimited,
          when: 'The queue is full',
          recovery: 'Wait the retryAfter seconds, then retry the call.',
        },
      ],
    });
    const error = await rejectionOf(service.countries(ctx));
    expect(error.data?.recovery).toEqual({
      hint: 'Wait the retryAfter seconds, then retry the call.',
    });
  });

  it('fails a call whose deadline passes mid-request with a Timeout that says how to narrow', async () => {
    const { fake, service } = setup();
    fake.intercept({ endpoint: 'population', respond: hangUntilAborted });
    const error = await rejectionOf(
      service.population(syrQuery, createMockContext(), { deadlineMs: 150 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toContain('45 s budget');
    expect(error.data?.recovery).toEqual({
      hint: 'Narrow the year window or drop expand so the call needs fewer upstream requests, then retry.',
    });
  });

  it('fails an already-spent deadline without any request', async () => {
    const { fake, service } = setup();
    const error = await rejectionOf(
      service.population(syrQuery, createMockContext(), { deadlineMs: 0 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(fake.calls).toHaveLength(0);
  });

  it('charges every method of one call to the same 45 s clock, keyed on the call’s context', async () => {
    const { fake, service } = setup();
    const ctx = createMockContext();
    await service.countries(ctx);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 45_001);
    try {
      const spent = await rejectionOf(service.population(syrQuery, ctx));
      expect(spent.code).toBe(JsonRpcErrorCode.Timeout);
      expect(fake.urlsFor('population')).toHaveLength(0);
      await expect(service.population(syrQuery, createMockContext())).resolves.toMatchObject({
        complete: true,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects queued requests with RequestCancelled when disposed', async () => {
    const { service } = setup({ config: { requestsPerSecond: 1 } });
    await service.countries(createMockContext());
    const queued = service.footnotes(createMockContext());
    service.dispose();
    const error = await rejectionOf(queued);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('rejects a cancelled caller with its own abort reason, never rewrapped', async () => {
    const { service } = setup();
    const controller = new AbortController();
    controller.abort(new DOMException('caller went away', 'AbortError'));
    await expect(
      service.population(syrQuery, createMockContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'caller went away' });
  });
});

describe('caching and single-flight', () => {
  it('serves a repeated page from the response cache', async () => {
    const { fake, service } = setup();
    await service.population(syrQuery, createMockContext());
    const again = await service.population(syrQuery, createMockContext());
    expect(again.rows).toHaveLength(3);
    expect(fake.urlsFor('population')).toHaveLength(1);
  });

  it('refetches a cached page once its 6 h TTL lapses', async () => {
    let now = 0;
    const { fake, service } = setup({ now: () => now });
    await service.population(syrQuery, createMockContext());
    now += 6 * 60 * 60 * 1000;
    await service.population(syrQuery, createMockContext());
    expect(fake.urlsFor('population')).toHaveLength(2);
  });

  it('refetches every time when the cache is disabled', async () => {
    const { fake, service } = setup({ config: { cacheMaxBytes: 0 } });
    await service.population(syrQuery, createMockContext());
    await service.population(syrQuery, createMockContext());
    expect(fake.urlsFor('population')).toHaveLength(2);
  });

  it('collapses identical in-flight requests into one, and one caller cancelling fails only that caller', async () => {
    const { fake, service } = setup({ config: { cacheMaxBytes: 0 } });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.intercept({
      endpoint: 'population',
      once: true,
      respond: async () => {
        await gate;
        return Response.json(
          envelope([populationRow(2024, 'SYR', null, [9, 9, 9, 9, 9, 9, 9, 9, 9])]),
        );
      },
    });
    const controller = new AbortController();
    const first = service.population(syrQuery, createMockContext({ signal: controller.signal }));
    const second = service.population(syrQuery, createMockContext());
    controller.abort(new DOMException('first caller cancelled', 'AbortError'));
    release();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({
      rows: [expect.objectContaining({ refugees: 9 })],
    });
    expect(fake.urlsFor('population')).toHaveLength(1);
  });
});

describe('reference data', () => {
  it('parses the country table, trimming names and keeping entries without ISO3 out of the index', async () => {
    const { fake, service } = setup();
    const { list, table } = await service.countries(createMockContext());
    expect(list.find((c) => c.unhcrCode === 'CUW')?.name).toBe('Curacao');
    expect(list.find((c) => c.unhcrCode === 'UKN')).toMatchObject({
      iso3: 'UNK',
      iso2: 'UK',
      name: 'Unknown',
      nameLong: null,
    });
    expect(list.find((c) => c.unhcrCode === 'GFR')).toMatchObject({
      iso3: 'DEU',
      unsdRegion: 'Western Europe',
      majorArea: 'Europe',
      nationality: 'German',
    });
    expect(list.filter((c) => c.iso3 === null).map((c) => c.unhcrCode)).toEqual(['CRB', 'SGS']);
    expect(table.byIso3.has('CRB')).toBe(false);
    expect(fake.urls().map(String)).toEqual([`${BASE}/countries/?cf_type=ISO&limit=10000&page=1`]);
  });

  it('caches reference data for 24 h, then reloads it', async () => {
    let now = 0;
    const { fake, service } = setup({ now: () => now });
    await service.countries(createMockContext());
    now += 24 * 60 * 60 * 1000 - 1;
    await service.countries(createMockContext());
    expect(fake.urlsFor('countries')).toHaveLength(1);
    now += 1;
    await service.countries(createMockContext());
    expect(fake.urlsFor('countries')).toHaveLength(2);
  });

  it('drops a failed reference load so the next call retries it', async () => {
    const { fake, service } = setup();
    fake.intercept({ endpoint: 'countries', once: true, respond: htmlNotFound });
    await expect(service.countries(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
    await expect(service.countries(createMockContext())).resolves.toMatchObject({
      list: expect.any(Array),
    });
  });

  it('loads each regional bureau’s members and sorts bureaus by name', async () => {
    const { fake, service } = setup();
    const { regions, regionByIso3 } = await service.regions(createMockContext());
    expect(regions.map((region) => region.name)).toEqual([
      'Asia and the Pacific',
      'Eastern and Southern Africa',
      'Europe',
      'Middle East and North Africa',
      'The Americas',
      'West and Central Africa',
    ]);
    expect(regions.find((region) => region.id === 7)?.countries).toEqual([
      'AUT',
      'DEU',
      'GBR',
      'TUR',
      'UKR',
    ]);
    expect(regionByIso3.get('DEU')).toBe('Europe');
    expect(regionByIso3.get('SYR')).toBe('Middle East and North Africa');
    expect(regionByIso3.has('XXA')).toBe(false);
    const regionCalls = fake
      .urlsFor('countries')
      .map((url) => url.searchParams.get('unhcr_region'));
    expect(regionCalls.sort()).toEqual(['1', '2', '3', '5', '6', '7']);
    expect(fake.urlsFor('regions')).toHaveLength(1);
  });

  it('probes coverage from the first row of page 1 and the row on the last page', async () => {
    const { fake, service } = setup();
    await expect(service.coverage('population', createMockContext())).resolves.toEqual({
      firstYear: 1951,
      latestYear: 2025,
    });
    await expect(service.coverage('solutions', createMockContext())).resolves.toEqual({
      firstYear: 1959,
      latestYear: 2025,
    });
    const probes = fake.urlsFor('population').map(String);
    expect(probes).toEqual([
      `${BASE}/population/?cf_type=ISO&limit=1&page=1`,
      `${BASE}/population/?cf_type=ISO&limit=1&page=4`,
    ]);
    await service.coverage('population', createMockContext());
    expect(fake.urlsFor('population')).toHaveLength(2);
  });

  it('probes coverage with one request when the dataset fits one page', async () => {
    const { fake, service } = setup({
      tables: { unrwa: [populationRow(2024, null, null, [1, 1, 1, 1, 1, 1, 1, 1, 1])] },
    });
    await expect(service.coverage('unrwa', createMockContext())).resolves.toEqual({
      firstYear: 2024,
      latestYear: 2024,
    });
    expect(fake.urlsFor('unrwa')).toHaveLength(1);
  });

  it('fails the coverage probe as ServiceUnavailable when the dataset returns no rows', async () => {
    const { service } = setup({ tables: { idmc: [] } });
    await expect(service.coverage('idmc', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('reads the nowcast month and year from the snapshot', async () => {
    const { fake, service } = setup();
    await expect(service.nowcastPeriod(createMockContext())).resolves.toEqual({
      year: 2026,
      month: 'August',
    });
    expect(fake.urls().map(String)).toEqual([`${BASE}/nowcasting/?cf_type=ISO&limit=1&page=1`]);
  });

  it('fails the nowcast period as ServiceUnavailable when no snapshot exists', async () => {
    const { service } = setup({ tables: { nowcasting: [] } });
    await expect(service.nowcastPeriod(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('parses footnotes from the envelope without total, dropping entries with no text', async () => {
    const { fake, service } = setup();
    const notes = await service.footnotes(createMockContext());
    expect(notes).toHaveLength(10);
    expect(notes.every((note) => note.text !== '')).toBe(true);
    expect(notes[0]).toMatchObject({ asylumIso3: 'DEU', originIso3: null, years: '2025' });
    expect(fake.urls().map(String)).toEqual([`${BASE}/footnotes/?cf_type=ISO&limit=10000&page=1`]);
  });
});

describe('demographics and asylum dataset methods', () => {
  const usQuery: DatasetQuery = {
    origin: { mode: 'summed', codes: [] },
    asylum: { mode: 'listed', codes: ['USA'] },
    yearFrom: 2015,
    yearTo: 2016,
  };

  it('builds ptype_show=true into the canonical URL, before cf_type', () => {
    expect(
      buildUrl('demographics', {
        coo: ['SYR'],
        yearFrom: 2025,
        yearTo: 2025,
        ptypeShow: true,
        limit: 10_000,
        page: 1,
      }),
    ).toBe(
      `${BASE}/demographics/?coo=SYR&yearFrom=2025&yearTo=2025&ptype_show=true&cf_type=ISO&limit=10000&page=1`,
    );
    expect(buildUrl('demographics', { ptypeShow: false })).toBe(
      `${BASE}/demographics/?cf_type=ISO`,
    );
  });

  it('fetches demographics with ptype_show=true, one normalized row per population type', async () => {
    const { fake, service } = setup();
    const result = await service.demographics(
      { ...syrQuery, yearFrom: 2025, yearTo: 2025 },
      createMockContext(),
    );
    expect(fake.urls().map(String)).toEqual([
      `${BASE}/demographics/?coo=SYR&yearFrom=2025&yearTo=2025&ptype_show=true&cf_type=ISO&limit=10000&page=1`,
    ]);
    expect(result.complete).toBe(true);
    expect(result.unexpectedValues).toBe(0);
    expect(result.rows.map((row) => row.population_type)).toEqual([
      'OOC',
      'REF',
      'ASY',
      'HST',
      'IDP',
      'RDP',
      'RET',
    ]);
    // The service keeps UNHCR's "0" bands as zero; reading them as "no breakdown" is the tool's job.
    expect(result.rows[3]).toEqual({
      year: 2025,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: null,
      asylum_unhcr_code: null,
      asylum_name: null,
      population_type: 'HST',
      f_0_4: 0,
      f_5_11: 0,
      f_12_17: 0,
      f_18_59: 0,
      f_60: 0,
      f_other: 0,
      f_total: 0,
      m_0_4: 0,
      m_5_11: 0,
      m_12_17: 0,
      m_18_59: 0,
      m_60: 0,
      m_other: 0,
      m_total: 0,
      total: 16504958,
    });
    expect(result.rows[0]).toMatchObject({ f_18_59: 646, f_other: 0, m_total: 911, total: 5940 });
  });

  it('maps procedure_type, app_type, dec_level, and app_pc onto application rows', async () => {
    const { fake, service } = setup();
    const result = await service.asylumApplications(usQuery, createMockContext());
    expect(
      result.rows.map(({ year, authority, stage, decision_level, unit, applied }) => ({
        year,
        authority,
        stage,
        decision_level,
        unit,
        applied,
      })),
    ).toEqual([
      { year: 2015, authority: 'G', stage: 'N', decision_level: 'EO', unit: 'P', applied: 45394 },
      { year: 2015, authority: 'G', stage: 'N', decision_level: 'IN', unit: 'C', applied: 90582 },
      { year: 2016, authority: 'G', stage: 'N', decision_level: 'EO', unit: 'P', applied: 80567 },
      { year: 2016, authority: 'G', stage: 'N', decision_level: 'IN', unit: 'C', applied: 124234 },
    ]);
    expect(result.rows[0]).toMatchObject({
      origin_iso3: null,
      asylum_iso3: 'USA',
      asylum_unhcr_code: 'USA',
      asylum_name: 'United States of America',
    });
    expect(fake.urls().map(String)).toEqual([
      `${BASE}/asylum-applications/?coa=USA&yearFrom=2015&yearTo=2016&cf_type=ISO&limit=10000&page=1`,
    ]);
  });

  it('reads the decision unit from dec_pc and carries every outcome count', async () => {
    const { fake, service } = setup();
    const result = await service.asylumDecisions(usQuery, createMockContext());
    expect(result.rows[1]).toEqual({
      year: 2015,
      origin_iso3: null,
      origin_unhcr_code: null,
      origin_name: null,
      asylum_iso3: 'USA',
      asylum_unhcr_code: 'USA',
      asylum_name: 'United States of America',
      authority: 'G',
      decision_level: 'IN',
      unit: 'C',
      dec_recognized: 15298,
      dec_other: 0,
      dec_rejected: 290,
      dec_closed: 23415,
      dec_total: 39003,
    });
    expect(result.rows.map((row) => row.unit)).toEqual(['P', 'C', 'P', 'C']);
    expect(fake.urlsFor('asylum-decisions')[0]?.searchParams.get('coa')).toBe('USA');
  });

  it('returns only the rows, never the whole-query total UNHCR puts in the asylum envelope', async () => {
    const { fake, service } = setup();
    const url = buildUrl('asylum-applications', {
      coa: ['USA'],
      yearFrom: 2015,
      yearTo: 2016,
      limit: 10_000,
      page: 1,
    });
    const raw = (await (await fake.fetch(url)).json()) as { total: unknown };
    expect(raw.total).toEqual({ applied: 45394 + 90582 + 80567 + 124234 });

    const result = await service.asylumApplications(usQuery, createMockContext());
    expect(Object.keys(result).sort()).toEqual([
      'complete',
      'rows',
      'skippedRows',
      'unexpectedValues',
    ]);
    expect(result.rows).toHaveLength(4);
  });

  it('probes each new dataset’s span from its own year-sorted rows, without ptype_show', async () => {
    const { fake, service } = setup();
    const ctx = createMockContext();
    await expect(service.coverage('demographics', ctx)).resolves.toEqual({
      firstYear: 2001,
      latestYear: 2025,
    });
    await expect(service.coverage('asylum-applications', ctx)).resolves.toEqual({
      firstYear: 2000,
      latestYear: 2025,
    });
    await expect(service.coverage('asylum-decisions', ctx)).resolves.toEqual({
      firstYear: 2000,
      latestYear: 2025,
    });
    expect(fake.urlsFor('demographics').map(String)).toEqual([
      `${BASE}/demographics/?cf_type=ISO&limit=1&page=1`,
      `${BASE}/demographics/?cf_type=ISO&limit=1&page=2`,
    ]);
  });

  it('reports an omitted procedure column as null and an omitted count as an unexpected value', async () => {
    const {
      app_pc: _unit,
      applied: _applied,
      ...sparse
    } = applicationRow(2015, null, 'USA', ['G', 'N', 'EO', 'P', 45394]);
    const { service } = setup({
      tables: { 'asylum-applications': [...ASYLUM_APPLICATION_ROWS, { ...sparse, year: 2014 }] },
    });
    const result = await service.asylumApplications(
      { ...usQuery, yearFrom: 2014, yearTo: 2014 },
      createMockContext(),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({ year: 2014, stage: 'N', unit: null, applied: null }),
    ]);
    expect(result.unexpectedValues).toBe(1);
  });
});

describe('service accessor', () => {
  it('throws before init and returns the instance after', () => {
    disposeUnhcrService();
    expect(() => getUnhcrService()).toThrow(/not initialized/);
    const fake = createFakeUnhcr();
    const service = initUnhcrService({ fetch: fake.fetch, config: TEST_SERVICE_CONFIG });
    expect(getUnhcrService()).toBe(service);
  });

  it('disposes the previous instance when re-initialized', async () => {
    const fake = createFakeUnhcr();
    const first = initUnhcrService({ fetch: fake.fetch, config: TEST_SERVICE_CONFIG });
    initUnhcrService({ fetch: fake.fetch, config: TEST_SERVICE_CONFIG });
    await expect(first.countries(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
  });
});
