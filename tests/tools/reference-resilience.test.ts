/**
 * @fileoverview Reference refresh and upstream outage contracts through the tool boundary.
 * @module tests/tools/reference-resilience.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAsylumApplicationsTool } from '@/mcp-server/tools/definitions/get-asylum-applications.tool.js';
import { getAsylumDecisionsTool } from '@/mcp-server/tools/definitions/get-asylum-decisions.tool.js';
import { getDemographicsTool } from '@/mcp-server/tools/definitions/get-demographics.tool.js';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';
import { getSolutionsTool } from '@/mcp-server/tools/definitions/get-solutions.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { disposeUnhcrService, initUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { envelope, FOOTNOTE_ROWS } from '../fixtures/unhcr.js';
import { createFakeUnhcr, hangUntilAborted } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { TEST_SERVICE_CONFIG } from '../helpers/services.js';

const dayMs = 24 * 60 * 60 * 1_000;
const minuteMs = 60 * 1_000;
const input = { origin: 'SYR', expand: 'asylum', year_from: 2025, year_to: 2025, limit: 1 };

function setup() {
  let now = 0;
  const fake = createFakeUnhcr();
  initUnhcrService({ config: TEST_SERVICE_CONFIG, fetch: fake.fetch, now: () => now });
  return {
    fake,
    advanceCache: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  disposeUnhcrService();
  vi.useRealTimers();
});

it('keeps warm footnotes through a stalled refresh and composes each caller’s truncation notice', async () => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(getPopulationTool, input);
  const fresh = structuredOf(await call());
  expect(fresh.footnotes_total).toBeGreaterThan(0);
  expect(fresh.notice).toContain('Showing 1 of');
  advanceCache(dayMs);
  let stalled = true;
  fake.intercept({
    endpoint: 'footnotes',
    respond: (request) =>
      stalled
        ? hangUntilAborted(request)
        : Response.json(
            envelope(FOOTNOTE_ROWS.map((note) => ({ ...note, footnote: 'Updated caveat' }))),
          ),
  });
  let finished = false;
  const warming = Promise.all([call(), call()]).then((results) => {
    finished = true;
    return results;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(finished).toBe(true);
  for (const result of await warming) {
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      complete: true,
      footnotes_total: fresh.footnotes_total,
      footnotes: fresh.footnotes,
    });
    expect(structured.notice).toContain('Stale UNHCR footnotes (24 hours old)');
    expect(structured.notice).toContain('Showing 1 of');
    expect(textOf(result.content)).toContain('Stale UNHCR footnotes');
    expect(textOf(result.content)).toContain('Showing 1 of');
  }
  expect(fake.urlsFor('footnotes')).toHaveLength(2);
  stalled = false;
  expect(structuredOf(await call()).notice).toContain('Stale UNHCR footnotes');
  expect(fake.urlsFor('footnotes')).toHaveLength(2);
  advanceCache(minuteMs);
  const recovered = structuredOf(await call());
  expect(recovered.notice).not.toContain('Stale');
  expect(recovered.footnotes).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Updated caveat' })]),
  );
  expect(fake.urlsFor('footnotes')).toHaveLength(3);
});

it('discloses stale countries and bureau data alongside an alias and rejects it after the age limit', async () => {
  const { fake, advanceCache } = setup();
  const call = () =>
    runToolContract(listReferenceTool, { topic: 'countries', name_contains: 'turkey' });
  const fresh = structuredOf(await call());
  expect(fresh.notice).toContain('Read "turkey"');
  advanceCache(dayMs);
  for (const endpoint of ['countries', 'regions']) {
    fake.intercept({ endpoint, respond: () => new Response('', { status: 503 }) });
  }
  const warm = call();
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await warm;
  const stale = structuredOf(result);
  expect(stale.countries).toEqual(fresh.countries);
  expect(stale.notice).toContain('Read "turkey"');
  expect(stale.notice).toContain('Stale UNHCR countries');
  expect(stale.notice).toContain('Stale UNHCR regional bureaus');
  expect(textOf(result.content)).toContain('Stale UNHCR regional bureaus');
  expect(textOf(result.content)).toContain('turkey');
  advanceCache(6 * dayMs + 1);
  const old = call();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(errorOf(await old).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
});

it('keeps the complete reference when a later footnote page is empty', async () => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(getPopulationTool, input);
  const fresh = structuredOf(await call());
  advanceCache(dayMs);
  fake.intercept({
    endpoint: 'footnotes',
    respond: (request) =>
      Number(new URL(request.url).searchParams.get('page')) === 1
        ? Response.json(envelope(FOOTNOTE_ROWS.slice(0, 1), { maxPages: 2 }))
        : Response.json(envelope([], { maxPages: 2, page: 2 })),
  });
  const warm = call();
  await vi.advanceTimersByTimeAsync(10_000);
  const stale = structuredOf(await warm);
  expect(stale.notice).toContain('Stale UNHCR footnotes');
  expect(stale.footnotes_total).toBe(fresh.footnotes_total);
  expect(fake.urlsFor('footnotes').map((url) => url.searchParams.get('page'))).toEqual([
    '1',
    '1',
    '2',
    '2',
    '2',
  ]);
});

it('retains all bureau memberships when a nested membership refresh fails', async () => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(listReferenceTool, { topic: 'regions' });
  const fresh = structuredOf(await call());
  const bureauId = fake.urlsFor('countries')[0]?.searchParams.get('unhcr_region');
  expect(bureauId).toEqual(expect.any(String));
  advanceCache(dayMs);
  fake.intercept({
    endpoint: 'countries',
    matches: (params) => params.get('unhcr_region') === bureauId,
    respond: () => new Response('', { status: 503 }),
  });
  const warm = call();
  await vi.advanceTimersByTimeAsync(10_000);
  const stale = structuredOf(await warm);
  expect(stale.regions).toEqual(fresh.regions);
  expect(stale.notice).toContain('Stale UNHCR regional bureaus');
  expect(
    fake.urlsFor('countries').filter((url) => url.searchParams.get('unhcr_region') === bureauId),
  ).toHaveLength(4);
});

it.each([
  {
    endpoint: 'countries',
    topic: 'countries',
    items: [{ name: 'Missing code' }],
    label: 'countries',
  },
  {
    endpoint: 'regions',
    topic: 'regions',
    items: [{ id: null, name: 'Missing ID' }],
    label: 'regional bureaus',
  },
] as const)(
  'rejects a nonempty $endpoint response with no usable records',
  async ({ endpoint, topic, items, label }) => {
    const { fake, advanceCache } = setup();
    const call = () => runToolContract(listReferenceTool, { topic });
    const fresh = structuredOf(await call());
    advanceCache(dayMs);
    fake.intercept({
      endpoint,
      matches: (params) => !params.has('unhcr_region'),
      respond: () => Response.json(envelope([...items])),
    });
    const warm = call();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await warm;
    const stale = structuredOf(result);
    expect(stale[topic]).toEqual(fresh[topic]);
    expect(stale.notice).toContain(`Stale UNHCR ${label}`);
    expect(textOf(result.content)).toContain(`Stale UNHCR ${label}`);
  },
);

it.each([
  { name: 'nonempty but unusable footnotes', respond: () => envelope([{ footnote: ' ' }]) },
  { name: 'missing page count', respond: () => ({ page: 1, items: FOOTNOTE_ROWS.slice(0, 1) }) },
  {
    name: 'wrong continuation page',
    respond: () => envelope(FOOTNOTE_ROWS.slice(0, 1), { maxPages: 2, page: 1 }),
  },
] as const)('keeps last-good caveats on $name and recovers after cooldown', async ({ respond }) => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(getPopulationTool, input);
  const fresh = structuredOf(await call());
  advanceCache(dayMs);
  let broken = true;
  fake.intercept({
    endpoint: 'footnotes',
    respond: () => Response.json(broken ? respond() : envelope(FOOTNOTE_ROWS)),
  });
  const warm = call();
  await vi.advanceTimersByTimeAsync(10_000);
  const stale = structuredOf(await warm);
  expect(stale.footnotes_total).toBe(fresh.footnotes_total);
  expect(stale.notice).toContain('Stale UNHCR footnotes');
  broken = false;
  advanceCache(minuteMs);
  const recovered = structuredOf(await call());
  expect(recovered.notice).not.toContain('Stale UNHCR footnotes');
  expect(recovered.footnotes_total).toBe(fresh.footnotes_total);
});

it.each(['population', 'nowcasting'] as const)(
  'requires fresh %s coverage data after expiry',
  async (endpoint) => {
    const { fake, advanceCache } = setup();
    const call = () => runToolContract(listReferenceTool, { topic: 'coverage' });
    expect(structuredOf(await call()).coverage).toEqual(expect.any(Array));
    advanceCache(dayMs);
    fake.intercept({ endpoint, respond: () => new Response('', { status: 503 }) });
    const expired = call();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errorOf(await expired).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  },
);

it('surfaces a permanent footnote refresh failure despite an eligible last-good value', async () => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(getPopulationTool, input);
  expect(structuredOf(await call()).footnotes_total).toBeGreaterThan(0);
  advanceCache(dayMs);
  fake.intercept({ endpoint: 'footnotes', respond: () => new Response('', { status: 403 }) });
  const result = await call();
  expect(errorOf(result)).toMatchObject({
    code: JsonRpcErrorCode.Forbidden,
    data: { status: 403 },
  });
  expect(errorOf(result).data?.retryable).toBeUndefined();
  expect(textOf(result.content)).not.toContain('Stale');
  expect(fake.urlsFor('footnotes')).toHaveLength(2);
});

it('honors a 503 Retry-After past the usual stale cooldown', async () => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(getPopulationTool, input);
  expect(structuredOf(await call()).footnotes_total).toBeGreaterThan(0);
  advanceCache(dayMs);
  fake.intercept({
    endpoint: 'footnotes',
    once: true,
    respond: () => new Response('', { status: 503, headers: { 'retry-after': '90' } }),
  });
  expect(structuredOf(await call()).notice).toContain('Stale UNHCR footnotes');
  advanceCache(minuteMs);
  expect(structuredOf(await call()).notice).toContain('Stale UNHCR footnotes');
  expect(fake.urlsFor('footnotes')).toHaveLength(2);
  advanceCache(30_000);
  expect(structuredOf(await call()).notice).not.toContain('Stale UNHCR footnotes');
  expect(fake.urlsFor('footnotes')).toHaveLength(3);
});

it('rejects a row-capped refresh and leaves the prior complete list available', async () => {
  const { fake, advanceCache } = setup();
  const call = () => runToolContract(getPopulationTool, input);
  const fresh = structuredOf(await call());
  advanceCache(dayMs);
  let cappedRefresh = true;
  fake.intercept({
    endpoint: 'footnotes',
    respond: (request) =>
      cappedRefresh
        ? Response.json(
            envelope(FOOTNOTE_ROWS.slice(0, 1), {
              maxPages: 20,
              page: Number(new URL(request.url).searchParams.get('page')),
            }),
          )
        : new Response('', { status: 503 }),
  });
  const capped = await call();
  expect(errorOf(capped)).toMatchObject({
    code: JsonRpcErrorCode.ServiceUnavailable,
    data: { retryable: false },
  });
  cappedRefresh = false;
  const failed = call();
  await vi.advanceTimersByTimeAsync(10_000);
  const stale = structuredOf(await failed);
  expect(stale.footnotes_total).toBe(fresh.footnotes_total);
  expect(stale.notice).toContain('Stale UNHCR footnotes (24 hours old)');
});

it.each([
  ['503', () => new Response('', { status: 503 })],
  ['HTML', () => new Response('<html>ok</html>')],
  ['no items', () => Response.json({ page: 1 })],
  [
    'connection reset',
    () => {
      throw new TypeError('connection reset');
    },
  ],
  ['empty reference', () => Response.json(envelope([]))],
] as const)(
  'returns retry guidance for exhausted upstream %s failures on data and reference tools',
  async (_, respond) => {
    const { fake } = setup();
    fake.intercept({ endpoint: 'footnotes', respond });
    fake.intercept({ endpoint: 'regions', respond });
    const results = [
      runToolContract(getPopulationTool, input),
      runToolContract(getDemographicsTool, input),
      runToolContract(getSolutionsTool, input),
      runToolContract(getAsylumApplicationsTool, input),
      runToolContract(getAsylumDecisionsTool, input),
      runToolContract(listReferenceTool, { topic: 'regions' }),
    ];
    await vi.advanceTimersByTimeAsync(10_000);
    for (const result of await Promise.all(results)) {
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { retryable: true, retryAttempts: 3, operation: 'UNHCR API request' },
      });
      expect(error.data?.recovery?.hint).toContain('retry the same call');
      expect(textOf(result.content)).toContain('retryable');
      expect(textOf(result.content)).toContain('retry the same call');
    }
  },
);
