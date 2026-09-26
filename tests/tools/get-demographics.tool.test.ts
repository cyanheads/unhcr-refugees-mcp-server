/**
 * @fileoverview Tests for unhcr_get_demographics over the fake UNHCR upstream
 * (recorded `ptype_show=true` rows) and a real in-memory DuckDB canvas: both
 * output surfaces on an under-cap, a zero-result, and an over-cap page;
 * `ptype_show` on the wire; band nulling where UNHCR publishes "0" in every
 * band of a row it has no breakdown for; `disaggregated` and the rounded
 * disaggregation share; the population_types filter with its own empty-result
 * notice and the footnotes that follow it; sorting; staged column types; every
 * declared error reason; and form-client blanks.
 * @module tests/tools/get-demographics.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDemographicsTool } from '@/mcp-server/tools/definitions/get-demographics.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  DEMOGRAPHICS_ROWS,
  demographicsRow,
  FOOTNOTE_ROWS,
  footnoteRow,
  NO_BREAKDOWN,
} from '../fixtures/unhcr.js';
import type { FakeTables, FakeUnhcr } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

type Input = z.input<typeof getDemographicsTool.input>;

let canvas: DataCanvas;
let fake: FakeUnhcr;

const upstream = (tables?: FakeTables) => {
  disposeUnhcrService();
  ({ fake } = initFakeUpstream(tables && { tables }));
};

beforeAll(() => {
  canvas = createTestCanvas();
});

afterAll(async () => {
  await shutdownCanvas(canvas);
});

beforeEach(() => {
  upstream();
  initCanvasBridge(canvas, { ttlMs: 60_000 });
});

afterEach(() => {
  disposeUnhcrService();
});

const context = () => createMockContext({ errors: getDemographicsTool.errors });

const call = (input: Input, ctx = context()) =>
  getDemographicsTool.handler(getDemographicsTool.input.parse(input), ctx);

const dataRequests = () =>
  fake.urlsFor('demographics').filter((url) => url.searchParams.has('yearFrom'));

type Row = Awaited<ReturnType<typeof call>>['rows'][number];

/** The fourteen band columns, female first. */
const BAND_FIELDS = ['female', 'male'].flatMap((sex) =>
  ['0_4', '5_11', '12_17', '18_59', '60_plus', 'unknown_age', 'total'].map(
    (band) => `${sex}_${band}` as keyof Row,
  ),
);

const bandsOf = (row: Row) => BAND_FIELDS.map((field) => row[field]);

/** Origin SYR, every asylum country summed, 2025: seven types, four without a breakdown. */
const syr2025: Input = { origin: 'SYR', year_from: 2025 };

describe('success, both surfaces', () => {
  it('returns an under-cap page through the production enrichment parse', async () => {
    const result = await runToolContract(getDemographicsTool, { origin: 'SYR', asylum: 'DEU' });
    const structured = structuredOf(result);
    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('dataset');
    expect(structured).toMatchObject({
      total_rows: 4,
      complete: true,
      measure: 'stock',
      latest_year: 2025,
      applied_scope: {
        origin: { mode: 'listed', codes: ['SYR'] },
        asylum: { mode: 'listed', codes: ['DEU'] },
        year_from: 2001,
        year_to: 2025,
      },
      attribution: { providers: [] },
    });
    const rows = structured.rows as Row[];
    // Upstream sends ASY before REF; rows follow the population_types code order.
    expect(rows.map((row) => [row.year, row.population_type])).toEqual([
      [2024, 'REF'],
      [2024, 'ASY'],
      [2025, 'REF'],
      [2025, 'ASY'],
    ]);
    expect(rows[0]).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: 'DEU',
      asylum_unhcr_code: 'GFR',
      asylum_name: 'Germany',
      population_type: 'REF',
      total: 725102,
      female_0_4: 22781,
      female_5_11: 52613,
      female_12_17: 35793,
      female_18_59: 146543,
      female_60_plus: 11326,
      female_unknown_age: 25,
      female_total: 269081,
      male_0_4: 24484,
      male_5_11: 56340,
      male_12_17: 46846,
      male_18_59: 313633,
      male_60_plus: 13979,
      male_unknown_age: 97,
      male_total: 455379,
      disaggregated: true,
      sex_disaggregated_share: 0.9991,
    });
    expect(rows[1]).toMatchObject({
      female_unknown_age: 0,
      male_unknown_age: 0,
      sex_disaggregated_share: 0.9943,
    });
    expect(structured.footnotes).toEqual([
      expect.objectContaining({ asylum_iso3: 'DEU', years: '2025', rows_matched: 2 }),
      expect.objectContaining({ origin_iso3: 'SYR', population_types: ['RET', 'RDP'] }),
    ]);
    expect(structured.footnotes_total).toBe(2);

    const text = textOf(result.content);
    for (const expected of [
      '**Scope:** origin listed SYR · asylum listed DEU · years 2001–2025',
      '**Measure:** stock · **Latest year:** 2025 · **Rows:** 4 shown of 4 total · **Complete:** yes',
      '| 2024 | Syrian Arab Rep. [SYR · UNHCR SYR] | Germany [DEU · UNHCR GFR] | REF Refugees | 725,102 | yes | 99.91% | 22,781 | 52,613 | 35,793 | 146,543 | 11,326 | 25 | 269,081 | 24,484 | 56,340 | 46,846 | 313,633 | 13,979 | 97 | 455,379 |',
      '### Footnotes (2 of 2)',
      '> Since 2022, the total figure of refugees from Ukraine in Germany',
      'Source: UNHCR Refugee Population Statistics Database (CC BY 4.0)',
    ]) {
      expect(text).toContain(expected);
    }
    for (const note of structured.data_notes as string[]) expect(text).toContain(note);
  });

  it('returns a zero-result page with the both-dimensions notice through the production enrichment parse', async () => {
    const result = await runToolContract(getDemographicsTool, { origin: 'SYR', asylum: 'CUW' });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      rows: [],
      total_rows: 0,
      complete: true,
      footnotes: [],
      footnotes_total: 0,
    });
    expect(structured.notice).toContain('origin SYR in asylum CUW');
    const text = textOf(result.content);
    expect(text).toContain('**Footnotes:** none match (0 total)');
    expect(text).toContain(String(structured.notice));
  });

  it('returns an over-cap page with the truncation fields and the staged dataframe pointer', async () => {
    const result = await runToolContract(getDemographicsTool, {
      origin: 'SYR',
      expand: 'asylum',
      limit: 4,
    });
    const structured = structuredOf(result);
    const dataset = structured.dataset as { name: string; row_count: number };
    expect(dataset.row_count).toBe(26);
    expect(structured).toMatchObject({ total_rows: 26, truncated: true, shown: 4, cap: 4 });
    expect(
      (structured.rows as Row[]).map((row) => [row.year, row.asylum_iso3, row.population_type]),
    ).toEqual([
      [2024, 'DEU', 'REF'],
      [2024, 'DEU', 'ASY'],
      [2025, 'AUS', 'REF'],
      [2025, 'AUS', 'ASY'],
    ]);
    expect(structured.notice).toContain(dataset.name);
    expect(textOf(result.content)).toContain('**Rows:** 4 shown of 26 total');
  });
});

describe('breakdowns', () => {
  it('asks UNHCR for one row per type with ptype_show=true, on the data request only', async () => {
    await call(syr2025);
    const [data, ...more] = dataRequests();
    expect(more).toHaveLength(0);
    expect(data?.searchParams.get('ptype_show')).toBe('true');
    expect(data?.searchParams.get('cf_type')).toBe('ISO');
    expect(data?.searchParams.get('coo')).toBe('SYR');
    const probes = fake.urlsFor('demographics').filter((url) => !url.searchParams.has('yearFrom'));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.searchParams.has('ptype_show')).toBe(false);
  });

  it('nulls every band of a row UNHCR has no breakdown for, where it publishes "0"', async () => {
    const result = await runToolContract(getDemographicsTool, syr2025);
    const rows = structuredOf(result).rows as Row[];
    expect(rows.map((row) => [row.population_type, row.disaggregated])).toEqual([
      ['REF', true],
      ['ASY', true],
      ['IDP', false],
      ['OOC', true],
      ['HST', false],
      ['RET', false],
      ['RDP', false],
    ]);
    for (const row of rows.filter((candidate) => !candidate.disaggregated)) {
      expect(bandsOf(row), String(row.population_type)).toEqual(BAND_FIELDS.map(() => null));
      expect(row.sex_disaggregated_share).toBe(0);
      expect(row.total).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.population_type === 'HST')?.total).toBe(16504958);
    expect(textOf(result.content)).toContain(
      `| 2025 | Syrian Arab Rep. [SYR · UNHCR SYR] | all (summed) | HST Host community | 16,504,958 | no | 0.00% | ${BAND_FIELDS.map(() => '—').join(' | ')} |`,
    );
  });

  it('keeps a published zero as zero inside a row that has a breakdown', async () => {
    const [asylumSeekers] = (
      await call({ origin: 'SYR', asylum: 'GBR', year_from: 2025, population_types: ['ASY'] })
    ).rows;
    expect(asylumSeekers).toMatchObject({
      disaggregated: true,
      sex_disaggregated_share: 1,
      female_0_4: 0,
      female_18_59: 0,
      female_unknown_age: 1132,
      male_60_plus: 0,
      male_unknown_age: 6369,
      male_total: 6369,
    });
  });

  it('rounds the disaggregation share to four decimal places', async () => {
    const result = await call(syr2025);
    const share = (type: string) =>
      result.rows.find((row) => row.population_type === type)?.sex_disaggregated_share;
    expect(share('OOC')).toBe(0.3668);
    expect(share('REF')).toBe(0.993);
    expect(share('ASY')).toBe(0.9861);
    expect(textOf(getDemographicsTool.format!(result))).toContain(
      '| OOC Others of concern | 5,940 | yes | 36.68% |',
    );
  });

  it('leaves the share null when the total is zero, keeping the zero bands', async () => {
    upstream({
      demographics: [
        ...DEMOGRAPHICS_ROWS,
        // Illustrative: a row whose total is zero.
        demographicsRow(2025, 'SYR', 'JPN', 'ASY', '0', NO_BREAKDOWN),
      ],
    });
    const [row] = (
      await call({ origin: 'SYR', asylum: 'JPN', year_from: 2025, population_types: ['ASY'] })
    ).rows;
    expect(row).toMatchObject({ total: 0, disaggregated: false, sex_disaggregated_share: null });
    expect(bandsOf(row!)).toEqual(BAND_FIELDS.map(() => 0));
  });

  it('reports a band upstream omitted as null, never zero, and counts it', async () => {
    const baseline = await call({ origin: 'SYR', asylum: 'TUR', year_from: 2025 });
    const recorded = DEMOGRAPHICS_ROWS.find(
      (raw) => raw.coo_iso === 'SYR' && raw.coa_iso === 'TUR' && raw.year === 2025,
    );
    const { f_60: _omitted, ...sparse } = recorded!;
    upstream({ demographics: [...DEMOGRAPHICS_ROWS.filter((raw) => raw !== recorded), sparse] });
    const result = await call({ origin: 'SYR', asylum: 'TUR', year_from: 2025 });
    expect(result.rows[0]).toMatchObject({
      female_60_plus: null,
      female_18_59: 558194,
      female_total: 1135265,
      disaggregated: true,
    });
    const added = result.data_notes.filter((note) => !baseline.data_notes.includes(note));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/\b1\b/);
  });
});

describe('paging and the row cap', () => {
  const syrPairs: Input = { origin: 'SYR', expand: 'asylum', limit: 500 };

  it('walks every page with ptype_show=true and keeps each type row', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({ pageSize: { demographics: 3 } }));
    const result = await call(syrPairs);
    expect(result).toMatchObject({ complete: true, total_rows: 26 });
    const pages = dataRequests();
    expect(pages.map((url) => Number(url.searchParams.get('page')))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    for (const page of pages) expect(page.searchParams.get('ptype_show')).toBe('true');
    const syrSyr = result.rows.filter((row) => row.asylum_iso3 === 'SYR');
    expect(syrSyr.map((row) => row.population_type)).toEqual(['IDP', 'HST', 'RET', 'RDP']);
  });

  it('reports a fetch the row cap stopped as complete: false on both surfaces', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({ pageSize: { demographics: 3 }, config: { maxRows: 10_000 } }));
    const result = await runToolContract(getDemographicsTool, syrPairs);
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ complete: false, total_rows: 3 });
    expect(structured.notice).toEqual(expect.any(String));
    expect(textOf(result.content)).toContain('**Complete:** no');
    expect(dataRequests()).toHaveLength(1);
  });

  it('names the upstream rows the capped fetch returned when population_types narrows them, on both surfaces', async () => {
    disposeUnhcrService();
    initFakeUpstream({ pageSize: { demographics: 3 }, config: { maxRows: 10_000 } });
    const result = await runToolContract(getDemographicsTool, {
      ...syrPairs,
      population_types: ['REF'],
    });
    const structured = structuredOf(result);
    expect(structured.complete).toBe(false);
    expect(structured.total_rows).toBeLessThan(3);
    const notice = String(structured.notice);
    expect(notice).toContain(
      "The fetch stopped at the server's row cap after 3 upstream rows, so this result is partial.",
    );
    expect(textOf(result.content)).toContain(`> ${notice}`);
  });
});

describe('population_types and footnotes', () => {
  it('filters types locally and case-insensitively over the full result', async () => {
    const result = await call({ ...syr2025, population_types: ['ref', ' Asy '] });
    expect(result.rows.map((row) => row.population_type)).toEqual(['REF', 'ASY']);
    expect(dataRequests()).toHaveLength(1);
    expect(dataRequests()[0]?.searchParams.has('columns')).toBe(false);
  });

  it('gives the filter its own notice when it empties rows UNHCR returned', async () => {
    const result = await runToolContract(getDemographicsTool, {
      ...syr2025,
      population_types: ['STA', 'oip'],
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], total_rows: 0, footnotes: [] });
    const notice = String(structured.notice);
    expect(notice).toContain('population_types');
    expect(notice).toContain('STA, OIP');
    expect(notice).not.toContain('UNHCR reports no');
    expect(textOf(result.content)).toContain(notice);
  });

  it('keeps the scope notice when UNHCR returned nothing, even with a filter', async () => {
    const ctx = context();
    await call({ origin: 'SYR', asylum: 'CUW', population_types: ['REF'] }, ctx);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('origin SYR in asylum CUW');
    expect(notice).not.toContain('population_types');
  });

  it('matches footnotes on the filtered types, so a returns caveat stays off a refugees-only answer', async () => {
    const returnsCaveat = (result: Awaited<ReturnType<typeof call>>) =>
      result.footnotes.find((note) => note.population_types.join() === 'RET,RDP');

    const unfiltered = await call(syr2025);
    expect(returnsCaveat(unfiltered)).toMatchObject({ origin_iso3: 'SYR', rows_matched: 7 });

    const refugees = await call({ ...syr2025, population_types: ['REF'] });
    expect(returnsCaveat(refugees)).toBeUndefined();
    expect(refugees.footnotes_total).toBe(0);

    const returns = await call({ ...syr2025, population_types: ['RET'] });
    expect(returnsCaveat(returns)).toMatchObject({ rows_matched: 1 });

    const germany = await call({ origin: 'SYR', asylum: 'DEU', population_types: ['ASY'] });
    expect(germany.footnotes.some((note) => note.asylum_iso3 === 'DEU')).toBe(false);
  });

  it('brings the folded types along: ROC with REF, IOC with IDP', async () => {
    upstream({
      footnotes: [
        ...FOOTNOTE_ROWS,
        // Illustrative: caveats naming only a type folded into another column.
        footnoteRow({
          footnote: 'Refugee-like figures for Syrians are estimates.',
          year: '2025',
          coo: 'SYR',
          coa: null,
          population_type: 'ROC',
        }),
        footnoteRow({
          footnote: 'IDP-like figures for Syria are estimates.',
          year: '2025',
          coo: 'SYR',
          coa: null,
          population_type: 'IOC',
        }),
      ],
    });
    const texts = async (types: Input['population_types']) =>
      (await call({ ...syr2025, population_types: types })).footnotes.map((note) => note.text);

    expect(await texts(['REF'])).toEqual(['Refugee-like figures for Syrians are estimates.']);
    expect(await texts(['IDP'])).toEqual(['IDP-like figures for Syria are estimates.']);
    expect(await texts(['ASY'])).toEqual([]);
  });

  it('treats blank and empty filters as unset', async () => {
    for (const population_types of ['', '  ', []] as unknown as Input['population_types'][]) {
      const result = await call({ ...syr2025, population_types });
      expect(result.total_rows).toBe(7);
    }
  });

  it.each([
    ['a type folded into another column', ['ROC']],
    ['a type demographics does not break down', ['RST']],
    ['an unknown code', ['XYZ']],
    ['a bare string', 'REF'],
  ])('rejects %s as invalid params before any upstream request', async (_label, types) => {
    const result = await runToolContract(getDemographicsTool, {
      ...syr2025,
      population_types: types as Input['population_types'],
    });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('sorting', () => {
  it('orders by year, origin, asylum, then population type by default', async () => {
    const result = await call({ origin: 'SYR', expand: 'asylum', year_from: 2025, limit: 10 });
    expect(result.rows.map((row) => `${row.asylum_iso3} ${row.population_type}`)).toEqual([
      'AUS REF',
      'AUS ASY',
      'AUT REF',
      'AUT ASY',
      'DEU REF',
      'DEU ASY',
      'EGY REF',
      'GBR REF',
      'GBR ASY',
      'IRQ REF',
    ]);
  });

  it('sorts by total largest first before the cut', async () => {
    const result = await call({ ...syr2025, sort_by: 'total', limit: 3 });
    expect(result.total_rows).toBe(7);
    expect(result.rows.map((row) => [row.population_type, row.total])).toEqual([
      ['HST', 16504958],
      ['IDP', 5542227],
      ['REF', 4865764],
    ]);
  });

  it('treats form-client blanks as unset', async () => {
    const result = await runToolContract(getDemographicsTool, {
      origin: '',
      asylum: '',
      expand: ' ' as 'none',
      year_from: '' as unknown as number,
      year_to: '' as unknown as number,
      sort_by: '' as 'year',
    });
    const structured = structuredOf(result);
    expect(structured.applied_scope).toMatchObject({
      origin: { mode: 'summed' },
      asylum: { mode: 'summed' },
      year_from: 2001,
      year_to: 2025,
    });
    expect((structured.rows as Row[]).map((row) => row.year)).toEqual([
      ...Array(6).fill(2001),
      ...Array(9).fill(2025),
    ]);
  });
});

describe('staging', () => {
  it('stages disaggregated as BOOLEAN, the share as DOUBLE, the type as VARCHAR, and bands as INTEGER', async () => {
    const ctx = context();
    const result = await call({ ...syr2025, stage: true }, ctx);
    expect(result.dataset?.row_count).toBe(7);
    const { result: staged } = await getCanvasBridge()!.query(
      ctx,
      `SELECT population_type, total, female_0_4, disaggregated, sex_disaggregated_share,
         typeof(population_type) AS type_type, typeof(female_0_4) AS band_type,
         typeof(disaggregated) AS flag_type, typeof(sex_disaggregated_share) AS share_type
       FROM ${result.dataset?.name} WHERE population_type IN ('OOC', 'HST') ORDER BY total`,
      { rowLimit: 10 },
    );
    const types = {
      type_type: 'VARCHAR',
      band_type: 'INTEGER',
      flag_type: 'BOOLEAN',
      share_type: 'DOUBLE',
    };
    expect(staged.rows).toEqual([
      {
        population_type: 'OOC',
        total: 5940,
        female_0_4: 128,
        disaggregated: true,
        sex_disaggregated_share: 0.3668,
        ...types,
      },
      {
        population_type: 'HST',
        total: 16504958,
        female_0_4: null,
        disaggregated: false,
        sex_disaggregated_share: 0,
        ...types,
      },
    ]);
  });
});

describe('declared errors, by reason', () => {
  it('fails unknown_country_code, refusing UK and naming GBR', async () => {
    const error = errorOf(await runToolContract(getDemographicsTool, { asylum: 'UK' }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'unknown_country_code', codes: ['UK'] });
    expect(error.data?.recovery?.hint).toContain('GBR');
    expect(dataRequests()).toHaveLength(0);
  });

  it('fails invalid_year_window without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getDemographicsTool, { year_from: 2024, year_to: 2020 }),
    );
    expect(error.data).toMatchObject({ reason: 'invalid_year_window' });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails year_out_of_coverage for a window before 2001, naming the demographics span', async () => {
    const error = errorOf(await runToolContract(getDemographicsTool, { year_to: 2000 }));
    expect(error.data).toMatchObject({
      reason: 'year_out_of_coverage',
      coverage: { first_year: 2001, latest_year: 2025 },
    });
    expect(error.data?.recovery?.hint).toContain('2001–2025');
    expect(dataRequests()).toHaveLength(0);
  });

  it('clamps a window reaching before the data, and says so', async () => {
    const ctx = context();
    const result = await call({ origin: 'SYR', asylum: 'DEU', year_from: 1995 }, ctx);
    expect(result.applied_scope).toMatchObject({ year_from: 2001, year_to: 2025 });
    expect(getEnrichment(ctx).notice).toContain('1995');
  });

  it('fails conflicting_scope without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getDemographicsTool, { origin: 'SYR', expand: 'origin' }),
    );
    expect(error.data).toMatchObject({ reason: 'conflicting_scope', conflicts: ['origin'] });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails upstream_busy with a retryAfter when UNHCR answers 429 on the data request', async () => {
    // A Retry-After past the 45 s call budget fails fast instead of waiting to retry.
    fake.intercept({
      endpoint: 'demographics',
      matches: (params) => params.has('yearFrom'),
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '75' } }),
    });
    const error = errorOf(await runToolContract(getDemographicsTool, { origin: 'SYR' }));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_busy', retryable: true, retryAfter: 75 },
    });
    expect(error.data?.recovery?.hint).toBe(
      getDemographicsTool.errors?.find((entry) => entry.reason === 'upstream_busy')?.recovery,
    );
  });
});

describe('declared surface', () => {
  it('declares the five shared reasons, upstream_busy retryable, and read-only open-world annotations', () => {
    expect(getDemographicsTool.errors?.map((entry) => entry.reason).sort()).toEqual([
      'conflicting_scope',
      'invalid_year_window',
      'unknown_country_code',
      'upstream_busy',
      'year_out_of_coverage',
    ]);
    expect(
      getDemographicsTool.errors?.find((entry) => entry.reason === 'upstream_busy')?.retryable,
    ).toBe(true);
    expect(getDemographicsTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('never routes callers to the drop tool, which is off by default', () => {
    const prose = JSON.stringify([
      getDemographicsTool.description,
      getDemographicsTool.errors,
      z.toJSONSchema(getDemographicsTool.input),
      z.toJSONSchema(getDemographicsTool.output),
    ]);
    expect(prose).not.toContain('unhcr_dataframe_drop');
  });
});
