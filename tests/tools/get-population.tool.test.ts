/**
 * @fileoverview Tests for unhcr_get_population over the fake UNHCR upstream
 * and a real in-memory DuckDB canvas: scope resolution and every declared
 * error reason, both output surfaces, the companion series join, the nowcast
 * branches, sorting before the cut, truncation and staging (including the
 * best-effort failure paths), the row cap, and form-client inputs.
 * @module tests/tools/get-population.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { TERMS_URL } from '@/services/unhcr/codes.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  MULTILINE_FOOTNOTE_TEXT,
  NOWCAST_ROWS,
  POPULATION_ROWS,
  populationRow,
} from '../fixtures/unhcr.js';
import { type FakeUnhcr, htmlNotFound } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import {
  createFailingCanvas,
  createTestCanvas,
  initFakeUpstream,
  shutdownCanvas,
} from '../helpers/services.js';

type Input = z.input<typeof getPopulationTool.input>;

let canvas: DataCanvas;
let fake: FakeUnhcr;

beforeAll(() => {
  canvas = createTestCanvas();
});

afterAll(async () => {
  await shutdownCanvas(canvas);
});

beforeEach(() => {
  ({ fake } = initFakeUpstream());
  initCanvasBridge(canvas, { ttlMs: 60_000 });
});

afterEach(() => {
  disposeUnhcrService();
});

const context = () => createMockContext({ errors: getPopulationTool.errors });

const call = (input: Input, ctx = context()) =>
  getPopulationTool.handler(getPopulationTool.input.parse(input), ctx);

/** Data requests (those carrying a year window) made to one endpoint. */
const dataRequests = (endpoint: string) =>
  fake.urlsFor(endpoint).filter((url) => url.searchParams.has('yearFrom'));

/** Origin SYR, every asylum country, 2025 only: five pair rows. */
const syrPairs2025: Input = { origin: 'SYR', expand: 'asylum', year_from: 2025, year_to: 2025 };

describe('success, both surfaces', () => {
  it('returns an under-cap page through the production enrichment parse', async () => {
    const result = await runToolContract(getPopulationTool, { origin: 'SYR', asylum: 'DEU' });
    const structured = structuredOf(result);

    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('dataset');
    expect(structured).toMatchObject({
      total_rows: 3,
      complete: true,
      measure: 'stock',
      latest_year: 2025,
      applied_scope: {
        origin: { mode: 'listed', codes: ['SYR'] },
        asylum: { mode: 'listed', codes: ['DEU'] },
        year_from: 1951,
        year_to: 2025,
        normalized: [],
      },
      attribution: {
        source: 'UNHCR Refugee Population Statistics Database',
        license: 'CC BY 4.0',
        terms_url: TERMS_URL,
        providers: [],
      },
      footnotes_total: 2,
    });
    const rows = structured.rows as Record<string, unknown>[];
    expect(rows[1]).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: 'DEU',
      asylum_unhcr_code: 'GFR',
      asylum_name: 'Germany',
      refugees: 725102,
      asylum_seekers: 62959,
      oip: null,
      idps: 0,
      stateless: 0,
      ooc: 0,
      hst: 0,
      returned_refugees: 0,
      returned_idps: 0,
    });
    expect(structured.footnotes).toEqual([
      expect.objectContaining({ asylum_iso3: 'DEU', years: '2025', rows_matched: 1 }),
      expect.objectContaining({
        origin_iso3: 'SYR',
        population_types: ['RET', 'RDP'],
        rows_matched: 2,
      }),
    ]);

    const text = textOf(result.content);
    for (const expected of [
      '**Scope:** origin listed SYR · asylum listed DEU · years 1951–2025',
      '**Measure:** stock · **Latest year:** 2025 · **Rows:** 3 shown of 3 total · **Complete:** yes',
      '| 2024 | Syrian Arab Rep. [SYR · UNHCR SYR] | Germany [DEU · UNHCR GFR] | 725,102 | 62,959 | — | 0 | 0 | 0 | 0 | 0 | 0 |',
      '### Footnotes (2 of 2)',
      '> Since 2022, the total figure of refugees from Ukraine in Germany',
      '- **2025** · any origin, asylum DEU · types REF · 1 rows matched',
      '### Data notes',
      '- null means UNHCR marks the category not applicable or not collected',
      `Source: UNHCR Refugee Population Statistics Database (CC BY 4.0); terms: ${TERMS_URL}.`,
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('returns a zero-result page with the both-dimensions notice through the production enrichment parse', async () => {
    const result = await runToolContract(getPopulationTool, { origin: 'SYR', asylum: 'JPN' });
    const structured = structuredOf(result);
    const notice =
      'No rows for origin SYR in asylum JPN in 1951–2025. Origin is where people fled from and asylum where they sought or hold protection (for returns, the country they returned from); swapping them is the common miss.';
    expect(structured).toMatchObject({
      rows: [],
      total_rows: 0,
      complete: true,
      footnotes: [],
      footnotes_total: 0,
      notice,
    });
    const text = textOf(result.content);
    expect(text).toContain('_No year-end rows._');
    expect(text).toContain('**Footnotes:** none match (0 total)');
    expect(text).toContain(`> ${notice}`);
  });

  it('returns an over-cap page with the truncation fields and the staged dataframe pointer', async () => {
    const result = await runToolContract(getPopulationTool, { ...syrPairs2025, limit: 2 });
    const structured = structuredOf(result);
    const dataset = structured.dataset as { name: string; row_count: number; expires_at: string };
    expect(dataset.name).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
    expect(dataset.row_count).toBe(5);
    expect(structured).toMatchObject({ total_rows: 5, truncated: true, shown: 2, cap: 2 });
    expect((structured.rows as { asylum_iso3: string }[]).map((row) => row.asylum_iso3)).toEqual([
      'DEU',
      'JOR',
    ]);
    expect(structured.notice).toBe(
      `Full set staged as ${dataset.name} (5 rows). Use unhcr_dataframe_describe to inspect its columns, then unhcr_dataframe_query to analyze it with SQL.`,
    );
    const text = textOf(result.content);
    expect(text).toContain(`**Dataset:** ${dataset.name} (5 rows, expires ${dataset.expires_at})`);
    expect(text).toContain('**Rows:** 2 shown of 5 total');
    expect(text).toContain('**truncated:** true');
  });

  it('keeps the upstream "0" as zero and "-" as null, and renders null as an em dash', async () => {
    const result = await call({ origin: 'SYR', asylum: 'SYR', year_from: 2025 });
    expect(result.rows).toEqual([
      expect.objectContaining({ refugees: 0, idps: 5542227, oip: null, hst: 16504958 }),
    ]);
    const text = textOf(getPopulationTool.format!(result));
    expect(text).toContain('| 0 | 0 | — | 5,542,227 |');
    expect(text).toContain('— marks null: not applicable or not collected.');
  });

  it('sends ISO3 with cf_type=ISO and both year bounds on every data request', async () => {
    await call({ origin: 'syr', asylum: 'deu', year_from: 2024 });
    for (const url of fake.urls()) expect(url.searchParams.get('cf_type')).toBe('ISO');
    for (const endpoint of ['population', 'unrwa', 'idmc']) {
      const data = fake.urlsFor(endpoint).filter((url) => url.searchParams.has('coo'));
      expect(data, endpoint).toHaveLength(1);
      expect(data[0]?.searchParams.get('coo')).toBe('SYR');
      expect(data[0]?.searchParams.get('coa')).toBe('DEU');
      expect(data[0]?.searchParams.get('yearFrom')).toBe('2024');
      expect(data[0]?.searchParams.get('yearTo')).toBe('2025');
    }
  });
});

describe('scope inputs', () => {
  it('rewrites ISO2 to ISO3, echoing each rewrite on both surfaces', async () => {
    const result = await runToolContract(getPopulationTool, { origin: 'sy', asylum: 'DE' });
    expect(structuredOf(result).applied_scope).toMatchObject({
      origin: { mode: 'listed', codes: ['SYR'] },
      asylum: { mode: 'listed', codes: ['DEU'] },
      normalized: [
        { input: 'SY', iso3: 'SYR' },
        { input: 'DE', iso3: 'DEU' },
      ],
    });
    expect(textOf(result.content)).toContain('normalized SY → SYR, DE → DEU');
  });

  it('returns each listed code as its own rows, never summed', async () => {
    const result = await call({ origin: 'syr, afg', year_from: 2025 });
    expect(result.rows.map((row) => [row.origin_iso3, row.refugees])).toEqual([
      ['AFG', 2671560],
      ['SYR', 4865764],
    ]);
    expect(result.applied_scope.origin).toEqual({ mode: 'listed', codes: ['SYR', 'AFG'] });
  });

  it('treats form-client blanks as unset: world scope, default sort, full coverage', async () => {
    const result = await runToolContract(getPopulationTool, {
      origin: '',
      asylum: '',
      expand: '' as 'none',
      sort_by: '' as 'year',
      year_from: '' as unknown as number,
      year_to: '' as unknown as number,
    });
    const structured = structuredOf(result);
    expect(structured.applied_scope).toEqual({
      origin: { mode: 'summed', codes: [] },
      asylum: { mode: 'summed', codes: [] },
      year_from: 1951,
      year_to: 2025,
      normalized: [],
    });
    expect((structured.rows as { year: number }[]).map((row) => row.year)).toEqual([
      1951, 2023, 2024, 2025,
    ]);
    expect(fake.urlsFor('countries')).toHaveLength(0);
  });

  it('treats a blank limit, stage, or include_nowcast as its default', async () => {
    const blanks = {
      origin: 'SYR',
      asylum: 'DEU',
      limit: '' as unknown as number,
      stage: ' ' as unknown as boolean,
      include_nowcast: '' as unknown as boolean,
    };
    expect(getPopulationTool.input.parse(blanks)).toMatchObject({
      limit: 100,
      stage: false,
      include_nowcast: false,
    });
    const result = await runToolContract(getPopulationTool, blanks);
    const structured = structuredOf(result);
    expect(structured.total_rows).toBe(3);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('dataset');
    expect(structured).not.toHaveProperty('nowcast');
    expect(textOf(result.content)).toContain('**Rows:** 3 shown of 3 total');
  });

  it('treats empty and blank-only code lists as unset', async () => {
    const result = await call({ origin: [], asylum: ['', '  '], year_from: 2025 });
    expect(result.applied_scope.origin.mode).toBe('summed');
    expect(result.applied_scope.asylum.mode).toBe('summed');
    expect(result.rows).toHaveLength(1);
  });

  it('clamps a window reaching past coverage and discloses both clamps', async () => {
    const ctx = context();
    const result = await call(
      { origin: 'SYR', asylum: 'DEU', year_from: 1900, year_to: 2030 },
      ctx,
    );
    expect(result.applied_scope).toMatchObject({ year_from: 1951, year_to: 2025 });
    expect(getEnrichment(ctx).notice).toBe(
      'year_from 1900 precedes the data (1951–2025), so the window starts at 1951. year_to 2030 is past the latest published year, so the window ends at 2025.',
    );
  });

  it.each([
    ['year_from below 1900', { year_from: 1899 }],
    ['year_to above 2100', { year_to: 2101 }],
    ['a fractional year', { year_from: 2020.5 }],
    ['a non-numeric year', { year_from: 'recent' as unknown as number }],
    ['limit 0', { limit: 0 }],
    ['limit above 500', { limit: 501 }],
    ['an unknown expand', { expand: 'sideways' as 'none' }],
    ['a sort field this tool lacks', { sort_by: 'total' as 'year' }],
    ['more than 50 codes as a list', { origin: Array.from({ length: 51 }, () => 'SYR') }],
  ])('rejects %s as invalid params before any upstream request', async (_label, input) => {
    const result = await runToolContract(getPopulationTool, input as Input);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects a string that splits past the 50-code cap, pointing at expand, before any request', async () => {
    const codes = Array.from({ length: 51 }, (_, i) => `X${String(i).padStart(2, '0')}`).join(',');
    const result = await runToolContract(getPopulationTool, { asylum: codes });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toContain('the limit is 50');
    expect(error.data?.recovery?.hint).toContain('set expand to list every country');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('declared errors, by reason', () => {
  it('fails unknown_country_code for a name, routing to unhcr_list_reference', async () => {
    const result = await runToolContract(getPopulationTool, { origin: 'Syria' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_country_code',
      codes: ['SYRIA'],
      recovery: {
        hint: 'Find the country with unhcr_list_reference (topic countries, name_contains) and pass its ISO3 code.',
      },
    });
    expect(textOf(result.content)).toContain('reason unknown_country_code');
    expect(fake.urls().map((url) => url.pathname)).toEqual(['/population/v1/countries/']);
  });

  it('names the exact ISO3 when given a UNHCR code', async () => {
    const result = await runToolContract(getPopulationTool, { asylum: 'GFR' });
    expect(errorOf(result).data).toMatchObject({
      reason: 'unknown_country_code',
      recovery: { hint: "GFR is UNHCR's code for Germany; pass DEU." },
    });
  });

  it('refuses UK and names GBR for the United Kingdom', async () => {
    const result = await runToolContract(getPopulationTool, { asylum: 'uk' });
    const error = errorOf(result);
    expect(error.data?.reason).toBe('unknown_country_code');
    expect(error.data?.recovery?.hint).toBe(
      'UK is not an ISO country code; the United Kingdom is GBR.',
    );
  });

  it('combines exact suggestions with routing for codes it cannot suggest', async () => {
    const result = await runToolContract(getPopulationTool, {
      origin: 'GFR, Syria',
      asylum: 'LEB',
    });
    const error = errorOf(result);
    expect(error.message).toBe(
      "Not an ISO3 code in UNHCR's country list: origin GFR, SYRIA; asylum LEB.",
    );
    expect(error.data?.recovery?.hint).toBe(
      "GFR is UNHCR's code for Germany; pass DEU. LEB is UNHCR's code for Lebanon; pass LBN. For SYRIA, find the country with unhcr_list_reference (topic countries, name_contains) and pass its ISO3 code.",
    );
  });

  it('fails invalid_year_window without any upstream request', async () => {
    const result = await runToolContract(getPopulationTool, { year_from: 2020, year_to: 2010 });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_year_window',
        year_from: 2020,
        year_to: 2010,
        recovery: {
          hint: 'Set year_from no later than year_to, or omit one bound to run to the edge of coverage.',
        },
      },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [{ origin: 'SYR', expand: 'origin' as const }, ['origin']],
    [{ asylum: 'DEU', expand: 'both' as const }, ['asylum']],
    [{ origin: 'SYR', asylum: 'DEU', expand: 'both' as const }, ['origin', 'asylum']],
  ])('fails conflicting_scope for %j without any upstream request', async (input, conflicts) => {
    const result = await runToolContract(getPopulationTool, input);
    expect(errorOf(result).data).toMatchObject({
      reason: 'conflicting_scope',
      conflicts,
      recovery: {
        hint: 'Either list codes in origin/asylum or expand that dimension, not both; drop the codes to list every country.',
      },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails year_out_of_coverage before the data, naming the span', async () => {
    const result = await runToolContract(getPopulationTool, { year_to: 1940 });
    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'year_out_of_coverage',
      coverage: { first_year: 1951, latest_year: 2025 },
    });
    expect(error.message).toBe(
      'Population data covers 1951–2025; the requested window (through 1940) lies outside it.',
    );
    expect(error.data?.recovery?.hint).toContain('covers 1951–2025');
    expect(error.data?.recovery?.hint).not.toContain('include_nowcast');
    expect(dataRequests('population')).toHaveLength(0);
  });

  it('adds the nowcast option to year_out_of_coverage for a window after the latest year', async () => {
    const result = await runToolContract(getPopulationTool, { year_from: 2027 });
    const hint = errorOf(result).data?.recovery?.hint;
    expect(hint).toContain('covers 1951–2025');
    expect(hint).toContain('set include_nowcast and omit origin');
  });

  it('still fails year_out_of_coverage after the latest year when origin is listed, even with include_nowcast', async () => {
    const result = await runToolContract(getPopulationTool, {
      origin: 'SYR',
      year_from: 2026,
      include_nowcast: true,
    });
    expect(errorOf(result).data).toMatchObject({ reason: 'year_out_of_coverage' });
    expect(fake.urlsFor('nowcasting')).toHaveLength(0);
  });

  it('fails upstream_busy with the tool’s recovery when UNHCR answers 429 on the data request', async () => {
    fake.intercept({
      endpoint: 'population',
      matches: (params) => params.has('yearFrom'),
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    });
    const result = await runToolContract(getPopulationTool, { origin: 'SYR' });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'upstream_busy',
        retryable: true,
        retryAfter: 60,
        recovery: {
          hint: 'Wait the retryAfter seconds the error carries, then retry; a narrower year window or no expand needs fewer upstream requests.',
        },
      },
    });
    expect(textOf(result.content)).toContain('reason upstream_busy · retryable');
  });

  it('fails the call when a companion series fails, rather than dropping it silently', async () => {
    fake.intercept({ endpoint: 'idmc', respond: htmlNotFound });
    const result = await runToolContract(getPopulationTool, { origin: 'SYR' });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('settles as RequestCancelled when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runToolContract(
      getPopulationTool,
      { origin: 'SYR' },
      { context: { signal: controller.signal } },
    );
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('companion series', () => {
  it('joins UNRWA beside asylum-country rows without adding it into refugees', async () => {
    const result = await runToolContract(getPopulationTool, { asylum: 'JOR' });
    const structured = structuredOf(result);
    const rows = structured.rows as Record<string, unknown>[];
    expect(rows.map((row) => [row.year, row.refugees, row.unrwa_refugees])).toEqual([
      [2023, 684066, 2392531],
      [2024, 643641, 2371387],
      [2025, 436226, 2398179],
    ]);
    expect(rows.every((row) => !('idmc_conflict_idps' in row))).toBe(true);
    expect(structured.attribution).toMatchObject({ providers: ['UNRWA'] });
    expect(structured.data_notes).toContain(
      'unrwa_refugees counts Palestine refugees registered with UNRWA, a separate series shown beside the row; it is never added into refugees.',
    );
    const text = textOf(result.content);
    expect(text).toContain('| UNRWA refugees |');
    expect(text).not.toContain('IDMC conflict IDPs');
    expect(text).toContain('2,392,531');
    expect(text).toContain('Includes third-party series: UNRWA.');
  });

  it('joins IDMC beside origin rows as a series separate from idps', async () => {
    const result = await call({ origin: 'SYR' });
    expect(result.rows.map((row) => [row.year, row.idps, row.idmc_conflict_idps])).toEqual([
      [2023, 7248188, 7248000],
      [2024, 7408909, 7409000],
      [2025, 5542227, 5964000],
    ]);
    expect(result.attribution.providers).toEqual(['IDMC']);
    expect(result.data_notes.some((note) => note.startsWith('idmc_conflict_idps is IDMC'))).toBe(
      true,
    );
    expect(textOf(getPopulationTool.format!(result))).toContain('| IDMC conflict IDPs |');
  });

  it('credits both providers on world rows, and leaves a companion off rows it has no figure for', async () => {
    const result = await call({ year_from: 1951, year_to: 2025 });
    expect(result.attribution.providers).toEqual(['IDMC', 'UNRWA']);
    const [first] = result.rows;
    expect(first?.year).toBe(1951);
    expect(first).not.toHaveProperty('unrwa_refugees');
    expect(first).not.toHaveProperty('idmc_conflict_idps');
    expect(result.rows[3]).toMatchObject({
      year: 2025,
      unrwa_refugees: 5964782,
      idmc_conflict_idps: 68653080,
    });
  });
});

describe('nowcast', () => {
  it('appends the current-year snapshot for the asylum scope, with its note', async () => {
    const result = await runToolContract(getPopulationTool, {
      asylum: 'DEU',
      include_nowcast: true,
    });
    const structured = structuredOf(result);
    expect(structured.nowcast).toEqual([
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
    ]);
    expect(structured.data_notes).toContain(
      'Nowcast figures are estimates for August 2026, sourced per country as the source field says.',
    );
    const text = textOf(result.content);
    expect(text).toContain('### Nowcast');
    expect(text).toContain(
      '| Germany [DEU · UNHCR GFR] | 2026 | August | 2,652,400 | 231,213 | Government |',
    );
  });

  it('skips the nowcast when origin lists codes, and says why', async () => {
    const ctx = context();
    const result = await call({ origin: 'SYR', include_nowcast: true }, ctx);
    expect(result).not.toHaveProperty('nowcast');
    expect(getEnrichment(ctx).notice).toBe(
      'include_nowcast was skipped: the nowcast has no origin dimension. Omit origin to get current-year estimates by asylum country.',
    );
    expect(fake.urlsFor('nowcasting')).toHaveLength(0);
  });

  it('answers a window after the latest year with the nowcast alone when include_nowcast is set', async () => {
    const result = await runToolContract(getPopulationTool, {
      asylum: 'JOR',
      year_from: 2026,
      include_nowcast: true,
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      rows: [],
      total_rows: 0,
      complete: true,
      latest_year: 2025,
      applied_scope: {
        origin: { mode: 'summed', codes: [] },
        asylum: { mode: 'listed', codes: ['JOR'] },
        year_from: 2026,
        year_to: 2026,
      },
      footnotes: [],
      footnotes_total: 0,
      nowcast: [expect.objectContaining({ asylum_iso3: 'JOR', refugees: 345321 })],
      notice:
        "Year-end figures stop at 2025, so no population rows fall in the requested window. The nowcast is UNHCR's August 2026 estimate of refugees and asylum-seekers by asylum country.",
    });
    expect(dataRequests('population')).toHaveLength(0);
    expect(textOf(result.content)).toContain('_No year-end rows._');
  });

  it('says so when the nowcast has no row for the asylum scope', async () => {
    const result = await runToolContract(getPopulationTool, {
      asylum: 'JPN',
      year_from: 2026,
      include_nowcast: true,
    });
    expect(structuredOf(result).notice).toBe(
      "Year-end figures stop at 2025, and UNHCR's nowcast has no row for this asylum scope.",
    );
    expect(textOf(result.content)).toContain('_No nowcast rows for this asylum scope._');
  });

  it('reports a month or source UNHCR omitted as null on both surfaces, dating the note by year alone', async () => {
    const { month: _month, source: _source, ...sparse } = NOWCAST_ROWS[1]!;
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({ tables: { nowcasting: [sparse] } }));
    const result = await runToolContract(getPopulationTool, {
      asylum: 'DEU',
      include_nowcast: true,
    });
    const structured = structuredOf(result);
    expect(structured.nowcast).toEqual([
      expect.objectContaining({
        asylum_iso3: 'DEU',
        year: 2026,
        month: null,
        source: null,
        refugees: 2652400,
      }),
    ]);
    const note =
      'Nowcast figures are estimates for 2026, sourced per country as the source field says.';
    expect(structured.data_notes).toContain(note);
    const text = textOf(result.content);
    expect(text).toContain('| Germany [DEU · UNHCR GFR] | 2026 | — | 2,652,400 | 231,213 | — |');
    expect(text).toContain(note);
  });

  it('dates the after-coverage notice by year alone when UNHCR sent no month', async () => {
    const { month: _month, ...sparse } = NOWCAST_ROWS[2]!;
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({ tables: { nowcasting: [sparse] } }));
    const result = await runToolContract(getPopulationTool, {
      asylum: 'JOR',
      year_from: 2026,
      include_nowcast: true,
    });
    const notice =
      "Year-end figures stop at 2025, so no population rows fall in the requested window. The nowcast is UNHCR's 2026 estimate of refugees and asylum-seekers by asylum country.";
    expect(structuredOf(result).notice).toBe(notice);
    expect(textOf(result.content)).toContain(`> ${notice}`);
  });

  it.each([
    ['beside the year-end rows', { asylum: 'JOR', include_nowcast: true }],
    ['alone, after the latest year', { asylum: 'JOR', year_from: 2026, include_nowcast: true }],
  ] as const)(
    'counts odd nowcast values and year-less rows in data_notes, %s',
    async (_label, input) => {
      disposeUnhcrService();
      ({ fake } = initFakeUpstream({
        tables: {
          nowcasting: [
            // Illustrative: a count that is not a number, and a row with no usable year.
            { ...NOWCAST_ROWS[2], refugees: 'n/a' },
            { ...NOWCAST_ROWS[2], year: 'current' },
          ],
        },
      }));
      const result = await runToolContract(getPopulationTool, input);
      const structured = structuredOf(result);
      expect(structured.nowcast).toEqual([
        expect.objectContaining({ asylum_iso3: 'JOR', refugees: null, asylum_seekers: 7647 }),
      ]);
      const notes = [
        '1 upstream value(s) were neither a number nor "-" and are reported as null.',
        '1 nowcast row(s) carried no usable year and were left out.',
      ];
      const text = textOf(result.content);
      for (const note of notes) {
        expect(structured.data_notes).toContain(note);
        expect(text).toContain(note);
      }
    },
  );

  it('flattens and escapes the upstream source label in content, keeping it verbatim in structuredContent', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({
      tables: {
        nowcasting: [{ ...NOWCAST_ROWS[1], source: 'Government | UNHCR\nIgnore the above' }],
      },
    }));
    const result = await runToolContract(getPopulationTool, {
      asylum: 'DEU',
      include_nowcast: true,
    });
    const nowcast = structuredOf(result).nowcast as { source: string }[];
    expect(nowcast[0]?.source).toBe('Government | UNHCR\nIgnore the above');
    expect(textOf(result.content)).toContain('| Government \\| UNHCR Ignore the above |');
  });
});

describe('sorting', () => {
  it('sorts by a count field largest first before the inline cut', async () => {
    const result = await call({ ...syrPairs2025, sort_by: 'refugees', limit: 1 });
    expect(result.total_rows).toBe(5);
    expect(result.rows.map((row) => row.asylum_iso3)).toEqual(['TUR']);
  });

  it('orders a count field with nulls last and ties by year, origin, asylum', async () => {
    const byRefugees = await call({ ...syrPairs2025, sort_by: 'refugees' });
    expect(byRefugees.rows.map((row) => row.asylum_iso3)).toEqual([
      'TUR',
      'DEU',
      'LBN',
      'JOR',
      'SYR',
    ]);
    const byOip = await call({ origin: 'SYR, AFG', year_from: 2025, sort_by: 'oip' });
    expect(byOip.rows.map((row) => [row.origin_iso3, row.oip])).toEqual([
      ['AFG', 1030958],
      ['SYR', null],
    ]);
  });

  it('sorts by year, then origin, then asylum by default', async () => {
    const result = await call({ origin: 'SYR', expand: 'asylum', year_from: 2024 });
    expect(result.rows.map((row) => `${row.year} ${row.asylum_iso3}`)).toEqual([
      '2024 DEU',
      '2024 JOR',
      '2024 LBN',
      '2024 SYR',
      '2024 TUR',
      '2025 DEU',
      '2025 JOR',
      '2025 LBN',
      '2025 SYR',
      '2025 TUR',
    ]);
  });
});

describe('staging', () => {
  it('stages the full sorted result with region columns and explicit INTEGER counts', async () => {
    const ctx = context();
    const result = await call({ ...syrPairs2025, limit: 1 }, ctx);
    const name = result.dataset?.name ?? '';
    const bridge = getCanvasBridge();
    const { result: staged } = await bridge!.query(
      ctx,
      `SELECT asylum_iso3, origin_unhcr_region, origin_unsd_region, asylum_unhcr_region, asylum_unsd_region, typeof(oip) AS oip_type, unrwa_refugees FROM ${name} ORDER BY asylum_iso3`,
      { rowLimit: 10 },
    );
    expect(staged.rows).toEqual([
      {
        asylum_iso3: 'DEU',
        origin_unhcr_region: 'Middle East and North Africa',
        origin_unsd_region: 'Western Asia',
        asylum_unhcr_region: 'Europe',
        asylum_unsd_region: 'Western Europe',
        oip_type: 'INTEGER',
        unrwa_refugees: null,
      },
      expect.objectContaining({
        asylum_iso3: 'JOR',
        asylum_unhcr_region: 'Middle East and North Africa',
      }),
      expect.objectContaining({ asylum_iso3: 'LBN' }),
      expect.objectContaining({ asylum_iso3: 'SYR' }),
      expect.objectContaining({ asylum_iso3: 'TUR', asylum_unhcr_region: 'Europe' }),
    ]);
  });

  it('stages on request under the limit, pointing at the dataframe without truncating', async () => {
    const ctx = context();
    const result = await call({ origin: 'SYR', asylum: 'DEU', stage: true }, ctx);
    expect(result.rows).toHaveLength(3);
    expect(result.dataset?.row_count).toBe(3);
    expect(getEnrichment(ctx)).toEqual({
      notice: `Full set staged as ${result.dataset?.name} (3 rows). Use unhcr_dataframe_describe to inspect its columns, then unhcr_dataframe_query to analyze it with SQL.`,
    });
  });

  it('never stages an empty result, even on request', async () => {
    const result = await call({ origin: 'SYR', asylum: 'JPN', stage: true });
    expect(result).not.toHaveProperty('dataset');
  });

  it('without a canvas, says how to see the rest of an overflowing result', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(getPopulationTool, { ...syrPairs2025, limit: 2 });
    const structured = structuredOf(result);
    expect(structured).not.toHaveProperty('dataset');
    expect(structured).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(structured.notice).toBe(
      'Showing 2 of 5 rows. Dataframes are unavailable in this deployment, so narrow the filters or year window, or raise limit (max 500), to see the rest.',
    );
  });

  it('without a canvas, notes that stage was ignored', async () => {
    initCanvasBridge(undefined);
    const ctx = context();
    await call({ origin: 'SYR', asylum: 'DEU', stage: true }, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'stage was ignored: dataframes are unavailable in this deployment.',
    );
  });

  it('keeps the inline rows when the DuckDB binding cannot load, then treats the canvas as off', async () => {
    const { canvas: failing } = createFailingCanvas();
    initCanvasBridge(failing, { ttlMs: 60_000 });

    const first = await runToolContract(getPopulationTool, { ...syrPairs2025, limit: 2 });
    const firstStructured = structuredOf(first);
    expect(firstStructured.rows).toHaveLength(2);
    expect(firstStructured).not.toHaveProperty('dataset');
    expect(firstStructured.notice).toBe(
      'The full set could not be staged as a dataframe; narrow the filters or year window, or raise limit (max 500), so it fits inline.',
    );
    expect(getCanvasBridge()?.available).toBe(false);

    const second = await runToolContract(getPopulationTool, { ...syrPairs2025, limit: 2 });
    expect(structuredOf(second).notice).toContain('Dataframes are unavailable in this deployment');
  });

  it('keeps the inline rows when the region map cannot load', async () => {
    fake.intercept({ endpoint: 'regions', respond: htmlNotFound });
    const ctx = context();
    const result = await call({ ...syrPairs2025, limit: 2 }, ctx);
    expect(result.rows).toHaveLength(2);
    expect(result).not.toHaveProperty('dataset');
    expect(getEnrichment(ctx).notice).toContain('could not be staged as a dataframe');
    const warnings = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
    expect(warnings.map((c) => c.msg)).toContain(
      'Region data for staging could not load; the inline rows stand',
    );
    expect(getCanvasBridge()?.available).toBe(true);
  });
});

describe('row cap and odd values', () => {
  it('reports a capped fetch as complete: false on both surfaces', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({ pageSize: { population: 2 }, config: { maxRows: 10_000 } }));
    const result = await runToolContract(getPopulationTool, syrPairs2025);
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ complete: false, total_rows: 2 });
    const notice =
      "The fetch stopped at the server's row cap after 2 upstream rows, so this result is partial. Narrow the year window, or list countries instead of expanding a dimension, to get a complete result.";
    expect(structured.notice).toBe(notice);
    const text = textOf(result.content);
    expect(text).toContain('**Complete:** no — the row cap stopped the fetch');
    expect(text).toContain(`> ${notice}`);
  });

  it('reports an upstream field omitted entirely as null, never zero, on both surfaces', async () => {
    const full = populationRow(2025, 'TIB', null, [15, 0, 0, 0, 0, 0, 0, '-', 0]);
    const { hst: _omitted, ...sparse } = full;
    disposeUnhcrService();
    initFakeUpstream({ tables: { population: [...POPULATION_ROWS, sparse] } });
    const result = await runToolContract(getPopulationTool, { origin: 'TIB' });
    const structured = structuredOf(result);
    expect(structured.rows).toEqual([expect.objectContaining({ refugees: 15, hst: null })]);
    expect(textOf(result.content)).toContain('| 15 | 0 | — | 0 | 0 | 0 | — | 0 | 0 |');
  });

  it('notes upstream values that were neither numbers nor "-"', async () => {
    disposeUnhcrService();
    initFakeUpstream({
      tables: {
        population: [
          ...POPULATION_ROWS,
          populationRow(2025, 'TIB', null, ['n/a', 0, 0, 0, 0, 0, 0, '-', 0]),
        ],
      },
    });
    const result = await call({ origin: 'TIB' });
    expect(result.rows[0]?.refugees).toBeNull();
    expect(result.data_notes).toContain(
      '1 upstream value(s) were neither a number nor "-" and are reported as null.',
    );
  });

  it('gives the one-dimension empty notice with the resolved window', async () => {
    const ctx = context();
    await call({ origin: 'TIB', year_from: 2020 }, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      "UNHCR reports no population rows for TIB in 2020–2025. Widen the year window, or check the dataset's span with unhcr_list_reference (topic coverage).",
    );
  });

  it('gives the world empty notice when nothing is filtered', async () => {
    const ctx = context();
    await call({ year_from: 1960, year_to: 1965 }, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      "No rows for 1960–1965. Check the dataset's span with unhcr_list_reference (topic coverage).",
    );
  });
});

describe('format', () => {
  it('blockquotes multi-line footnote text so each line stays inside the quote', async () => {
    const result = await call({ origin: 'SYR', asylum: 'DEU' });
    const text = textOf(
      getPopulationTool.format!({
        ...result,
        footnotes: [
          {
            text: MULTILINE_FOOTNOTE_TEXT,
            years: '2023',
            origin_iso3: null,
            asylum_iso3: 'ALB',
            population_types: ['STA'],
            rows_matched: 1,
          },
        ],
        footnotes_total: 1,
      }),
    );
    expect(text).toContain(
      '> The Albanian Government conducted the Population and Housing Census during the period of September–October 2023.\n>\n>\n>\n> The start-year figures',
    );
    expect(text).not.toContain('\r');
  });

  it('escapes pipes and flattens line breaks in upstream country names', async () => {
    const result = await call({ origin: 'SYR', asylum: 'DEU', year_from: 2025 });
    const [row] = result.rows;
    const text = textOf(
      getPopulationTool.format!({
        ...result,
        rows: [{ ...row!, asylum_name: 'Evil | Name\nInjected' }],
      }),
    );
    expect(text).toContain('Evil \\| Name Injected [DEU · UNHCR GFR]');
  });
});
