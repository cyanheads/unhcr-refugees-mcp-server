/**
 * @fileoverview Tests for unhcr_get_asylum_applications over the fake UNHCR
 * upstream (recorded asylum-application rows) and a real in-memory DuckDB
 * canvas: both output surfaces on an under-cap, a zero-result, and an
 * over-cap page; cases never summed with persons (the US multi-unit series);
 * split_by grouping; the stages filter and its own empty-result notice; the
 * unknown-unit skip; staged column types; every declared error reason; and
 * form-client blanks.
 * @module tests/tools/get-asylum-applications.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAsylumApplicationsTool } from '@/mcp-server/tools/definitions/get-asylum-applications.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { type ASYLUM_CODES, asylumCodeLabel } from '@/services/unhcr/codes.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  ASYLUM_APPLICATION_ROWS,
  applicationRow,
  COUNTRY_ROWS,
  type RawRow,
  USA_COUNTRY_ROW,
} from '../fixtures/unhcr.js';
import type { FakeUnhcr } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

type Input = z.input<typeof getAsylumApplicationsTool.input>;

let canvas: DataCanvas;
let fake: FakeUnhcr;

/** Serve the recorded tables with the US in the country table, plus any overrides. */
const upstream = (applications?: RawRow[]) => {
  disposeUnhcrService();
  ({ fake } = initFakeUpstream({
    tables: {
      countries: [...COUNTRY_ROWS, USA_COUNTRY_ROW],
      ...(applications && { 'asylum-applications': applications }),
    },
  }));
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

const context = () => createMockContext({ errors: getAsylumApplicationsTool.errors });

const call = (input: Input, ctx = context()) =>
  getAsylumApplicationsTool.handler(getAsylumApplicationsTool.input.parse(input), ctx);

/** Data requests (those carrying a year window) made to the applications endpoint. */
const dataRequests = () =>
  fake.urlsFor('asylum-applications').filter((url) => url.searchParams.has('yearFrom'));

/** `code label` as the legend decodes it, read from the code tables. */
const decoded = (list: keyof typeof ASYLUM_CODES, code: string) =>
  `${code} ${asylumCodeLabel(list, code)}`;

type Row = Awaited<ReturnType<typeof call>>['rows'][number];
const summary = (row: Row) => [row.year, row.unit, row.stages, row.applied];

describe('success, both surfaces', () => {
  it('returns an under-cap page through the production enrichment parse', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: 'SYR',
      asylum: 'DEU',
    });
    const structured = structuredOf(result);
    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('dataset');
    expect(structured).toMatchObject({
      total_rows: 6,
      complete: true,
      measure: 'flow',
      latest_year: 2025,
      applied_scope: {
        origin: { mode: 'listed', codes: ['SYR'] },
        asylum: { mode: 'listed', codes: ['DEU'] },
        year_from: 2000,
        year_to: 2025,
        normalized: [],
      },
      attribution: {
        source: 'UNHCR Refugee Population Statistics Database',
        license: 'CC BY 4.0',
        providers: [],
      },
    });
    const rows = structured.rows as Row[];
    expect(rows.map(summary)).toEqual([
      [2024, 'persons', ['A'], 10488],
      [2024, 'persons', ['N'], 76765],
      [2024, 'persons', ['R'], 2668],
      [2025, 'persons', ['A'], 17026],
      [2025, 'persons', ['N'], 23256],
      [2025, 'persons', ['R'], 984],
    ]);
    expect(rows[0]).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: 'DEU',
      asylum_unhcr_code: 'GFR',
      asylum_name: 'Germany',
      authorities: ['G'],
      stages: ['A'],
      decision_levels: ['JR'],
      unit: 'persons',
      applied: 10488,
    });

    const text = textOf(result.content);
    for (const expected of [
      '**Scope:** origin listed SYR · asylum listed DEU · years 2000–2025',
      '**Measure:** flow · **Latest year:** 2025 · **Rows:** 6 shown of 6 total · **Complete:** yes',
      '| 2024 | Syrian Arab Rep. [SYR · UNHCR SYR] | Germany [DEU · UNHCR GFR] | G | A | JR | persons | 10,488 |',
      '| 2025 | Syrian Arab Rep. [SYR · UNHCR SYR] | Germany [DEU · UNHCR GFR] | G | N | FI | persons | 23,256 |',
      decoded('authority', 'G'),
      decoded('application_stage', 'A'),
      decoded('application_stage', 'N'),
      decoded('application_stage', 'R'),
      decoded('decision_level', 'FI'),
      decoded('decision_level', 'JR'),
      decoded('decision_level', 'RA'),
      'Source: UNHCR Refugee Population Statistics Database (CC BY 4.0)',
    ]) {
      expect(text).toContain(expected);
    }
    for (const note of structured.data_notes as string[]) expect(text).toContain(note);
  });

  it('returns a zero-result page with the both-dimensions notice through the production enrichment parse', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: 'SYR',
      asylum: 'TUR',
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], total_rows: 0, complete: true });
    expect(structured).not.toHaveProperty('dataset');
    expect(structured.notice).toContain('origin SYR in asylum TUR');
    const text = textOf(result.content);
    expect(text).toContain('**Rows:** 0 shown of 0 total');
    expect(text).toContain(String(structured.notice));
  });

  it('returns an over-cap page with the truncation fields and the staged dataframe pointer', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, {
      year_from: 2025,
      split_by: ['authority', 'stage', 'decision_level'],
      limit: 5,
    });
    const structured = structuredOf(result);
    const dataset = structured.dataset as { name: string; row_count: number; expires_at: string };
    expect(dataset.name).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
    expect(dataset.row_count).toBe(25);
    expect(structured).toMatchObject({ total_rows: 25, truncated: true, shown: 5, cap: 5 });
    expect(structured.rows).toHaveLength(5);
    expect(structured.notice).toContain(dataset.name);
    const text = textOf(result.content);
    expect(text).toContain(`**Dataset:** ${dataset.name} (25 rows, expires ${dataset.expires_at})`);
    expect(text).toContain('**Rows:** 5 shown of 25 total');
    expect(text).toContain('**truncated:** true');
  });

  it('decodes each code in its own list, and reports an undocumented stage code as-is', async () => {
    const byLevel = await call({ year_from: 2025, stages: ['N'], split_by: ['decision_level'] });
    const text = textOf(getAsylumApplicationsTool.format!(byLevel));
    expect(byLevel.rows.map((row) => row.decision_levels[0])).toContain('NA');
    // NA is "New applications" as a decision level and "New and appeal" as a stage.
    expect(text).toContain(decoded('decision_level', 'NA'));
    expect(text).not.toContain(decoded('application_stage', 'NA'));

    const first = await call({ year_to: 2000 });
    expect(first.rows).toEqual([
      expect.objectContaining({ year: 2000, stages: ['V'], unit: 'cases', applied: 109482 }),
    ]);
    expect(textOf(getAsylumApplicationsTool.format!(first))).toContain(
      decoded('application_stage', 'V'),
    );
  });
});

describe('cases and persons', () => {
  it('never adds cases to persons in a year that mixes them: the US series', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, {
      asylum: 'USA',
      split_by: [],
    });
    const structured = structuredOf(result);
    expect(
      (structured.rows as Row[]).map((row) => [
        row.year,
        row.unit,
        row.decision_levels,
        row.applied,
      ]),
    ).toEqual([
      [2015, 'persons', ['EO'], 45394],
      [2015, 'cases', ['IN'], 90582],
      [2016, 'persons', ['EO'], 80567],
      [2016, 'cases', ['IN'], 124234],
    ]);
    const text = textOf(result.content);
    expect(text).toContain(
      '| 2015 | all (summed) | United States of America [USA · UNHCR USA] | G | N | EO | persons | 45,394 |',
    );
    expect(text).toContain(
      '| 2015 | all (summed) | United States of America [USA · UNHCR USA] | G | N | IN | cases | 90,582 |',
    );
    // Neither a per-year sum across units nor UNHCR's whole-query envelope total reaches a caller.
    for (const mixed of [45394 + 90582, 80567 + 124234, 45394 + 90582 + 80567 + 124234]) {
      expect(JSON.stringify(structured)).not.toContain(String(mixed));
      expect(text).not.toContain(mixed.toLocaleString('en-US'));
    }
  });

  it('keeps the units apart at world scope with every procedure dimension summed', async () => {
    const result = await call({ year_from: 2025, split_by: [] });
    expect(result.rows.map((row) => [row.unit, row.applied, row.decision_levels])).toEqual([
      ['persons', 2962872, ['AR', 'EO', 'FA', 'FI', 'JR', 'NA', 'RA', 'TA']],
      ['cases', 380331, ['AR', 'FI', 'IN', 'JR']],
    ]);
  });
});

describe('split_by and stages', () => {
  it('splits by stage by default, persons before cases within a year', async () => {
    const result = await call({ origin: 'SYR', year_from: 2025 });
    expect(result.rows.map(summary)).toEqual([
      [2025, 'persons', ['A'], 19079],
      [2025, 'persons', ['J'], 5],
      [2025, 'persons', ['N'], 49079],
      [2025, 'persons', ['NR'], 1220],
      [2025, 'persons', ['R'], 2358],
      [2025, 'persons', ['RA'], 259],
      [2025, 'cases', ['A'], 5],
      [2025, 'cases', ['N'], 9],
    ]);
    expect(result.rows[2]).toMatchObject({
      authorities: ['G', 'U'],
      decision_levels: ['EO', 'FA', 'FI', 'TA'],
    });
  });

  it('gives one total per year and unit with split_by []', async () => {
    const result = await call({ origin: 'SYR', split_by: [], year_from: 2024, year_to: 2024 });
    expect(result.rows).toEqual([
      expect.objectContaining({
        year: 2024,
        unit: 'persons',
        authorities: ['G', 'J', 'U'],
        stages: ['A', 'J', 'N', 'NR', 'R', 'RA'],
        applied: 181407,
      }),
    ]);
  });

  it('splits by authority alone, still keeping unit', async () => {
    const result = await call({ origin: 'SYR', split_by: ['authority'], year_from: 2025 });
    expect(result.rows.map((row) => [row.unit, row.authorities, row.applied])).toEqual([
      ['persons', ['G'], 71446],
      ['persons', ['U'], 554],
      ['cases', ['G'], 14],
    ]);
  });

  it('filters stages before summing, case-insensitively, and drops the repeat/appeal caveat for new claims only', async () => {
    const newOnly = await call({ origin: 'SYR', stages: [' n '], split_by: [], year_from: 2025 });
    expect(newOnly.rows.map(summary)).toEqual([
      [2025, 'persons', ['N'], 49079],
      [2025, 'cases', ['N'], 9],
    ]);
    const everyStage = await call({ origin: 'SYR', split_by: [], year_from: 2025 });
    const caveats = everyStage.data_notes.filter((note) => !newOnly.data_notes.includes(note));
    expect(caveats).toHaveLength(1);
    expect(newOnly.data_notes.every((note) => everyStage.data_notes.includes(note))).toBe(true);
  });

  it('gives the stages filter its own notice when it empties rows UNHCR returned', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: 'SYR',
      asylum: 'DEU',
      stages: ['V', 'ra'],
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], total_rows: 0 });
    const notice = String(structured.notice);
    expect(notice).toContain('stages');
    expect(notice).toContain('V, RA');
    expect(notice).not.toContain('origin SYR in asylum DEU');
    expect(notice).not.toContain('UNHCR reports no');
    expect(textOf(result.content)).toContain(notice);
    expect(dataRequests()).toHaveLength(1);
  });

  it('keeps the scope notice when UNHCR returned nothing, even with a stages filter', async () => {
    const ctx = context();
    await call({ origin: 'SYR', asylum: 'TUR', stages: ['N'] }, ctx);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('origin SYR in asylum TUR');
    expect(notice).not.toContain('stages');
  });

  it('sorts by applied largest first over the full result before the cut', async () => {
    const result = await call({ origin: 'SYR', year_from: 2025, sort_by: 'applied', limit: 2 });
    expect(result.total_rows).toBe(8);
    expect(result.rows.map(summary)).toEqual([
      [2025, 'persons', ['N'], 49079],
      [2025, 'persons', ['A'], 19079],
    ]);
  });

  it('treats form-client blanks as unset: default stage split, no stage filter, full coverage', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: '',
      asylum: '  ',
      expand: '' as 'none',
      year_from: '' as unknown as number,
      year_to: ' ' as unknown as number,
      split_by: '' as unknown as [],
      stages: '  ' as unknown as [],
      sort_by: '' as 'year',
    });
    const structured = structuredOf(result);
    expect(structured.applied_scope).toEqual({
      origin: { mode: 'summed', codes: [] },
      asylum: { mode: 'summed', codes: [] },
      year_from: 2000,
      year_to: 2025,
      normalized: [],
    });
    const rows = structured.rows as Row[];
    expect(rows.every((row) => row.stages.length === 1)).toBe(true);
    expect(rows.map((row) => row.year)).toEqual([...rows.map((row) => row.year)].sort());
    expect(new Set(rows.flatMap((row) => row.stages))).toContain('RA');
    expect(fake.urlsFor('countries')).toHaveLength(0);
  });

  it('treats an empty stages list as no filter', async () => {
    const all = await call({ origin: 'SYR', year_from: 2025, stages: [] });
    expect(all.total_rows).toBe(8);
  });

  it.each([
    ['an unknown stage code', { stages: ['X'] }],
    ['a stage code outside the list the tool accepts', { stages: ['ROC'] }],
    ['a bare string for stages', { stages: 'N' as unknown as [] }],
    ['a split dimension this tool lacks', { split_by: ['unit'] as unknown as [] }],
    ['more than three split entries', { split_by: ['stage', 'stage', 'stage', 'stage'] }],
    ['a sort field this tool lacks', { sort_by: 'recognized' as 'year' }],
    ['a fractional year', { year_from: 2020.5 }],
    ['a year below 1900', { year_to: 1899 }],
    ['limit 0', { limit: 0 }],
    ['limit above 500', { limit: 501 }],
  ])('rejects %s as invalid params before any upstream request', async (_label, input) => {
    const result = await runToolContract(getAsylumApplicationsTool, input as Input);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('paging and the row cap', () => {
  const worldTotals: Input = { year_from: 2025, split_by: [] };

  it('sums each group across every page of a multi-page walk', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({
      pageSize: { 'asylum-applications': 5 },
      tables: { countries: [...COUNTRY_ROWS, USA_COUNTRY_ROW] },
    }));
    const result = await call(worldTotals);
    expect(result.complete).toBe(true);
    expect(result.rows.map((row) => [row.unit, row.applied])).toEqual([
      ['persons', 2962872],
      ['cases', 380331],
    ]);
    expect(dataRequests().map((url) => url.searchParams.get('page'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  it('reports a fetch the row cap stopped as complete: false on both surfaces', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({
      pageSize: { 'asylum-applications': 5 },
      config: { maxRows: 10_000 },
    }));
    const result = await runToolContract(getAsylumApplicationsTool, worldTotals);
    const structured = structuredOf(result);
    // Only the first five upstream rows arrive: 1,294,468 + 323,940 + 58,274 + 137,858 persons.
    expect(structured).toMatchObject({ complete: false, total_rows: 2 });
    expect((structured.rows as Row[]).map((row) => [row.unit, row.applied])).toEqual([
      ['persons', 1814540],
      ['cases', 82273],
    ]);
    expect(structured.notice).toEqual(expect.any(String));
    expect(textOf(result.content)).toContain('**Complete:** no');
    expect(dataRequests()).toHaveLength(1);
  });

  it('names the upstream rows the capped fetch returned, not the aggregated row count, on both surfaces', async () => {
    disposeUnhcrService();
    initFakeUpstream({ pageSize: { 'asylum-applications': 5 }, config: { maxRows: 10_000 } });
    const result = await runToolContract(getAsylumApplicationsTool, worldTotals);
    const structured = structuredOf(result);
    expect(structured.total_rows).toBe(2);
    const notice =
      "The fetch stopped at the server's row cap after 5 upstream rows, so this result is partial. Narrow the year window, or list countries instead of expanding a dimension, to get a complete result.";
    expect(structured.notice).toBe(notice);
    expect(textOf(result.content)).toContain(`> ${notice}`);
  });
});

describe('odd upstream values', () => {
  const syrDeu2025: Input = { origin: 'SYR', asylum: 'DEU', year_from: 2025 };

  it('leaves out a row whose unit is neither P nor C, and counts it in data_notes', async () => {
    const baseline = await call(syrDeu2025);
    upstream([
      ...ASYLUM_APPLICATION_ROWS,
      // Illustrative: no recorded row carries a unit other than P or C.
      applicationRow(2025, 'SYR', 'DEU', ['G', 'N', 'FI', 'X', 999]),
    ]);
    const withOdd = await call(syrDeu2025);
    expect(withOdd.rows).toEqual(baseline.rows);
    const added = withOdd.data_notes.filter((note) => !baseline.data_notes.includes(note));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/\b1\b/);
  });

  describe('every row UNHCR returned has an unknown unit', () => {
    // Illustrative: no recorded row carries a unit other than P or C.
    const oddUnits = [
      applicationRow(2025, 'TIB', null, ['G', 'N', 'FI', 'X', 15]),
      applicationRow(2025, 'TIB', null, ['G', 'R', 'FI', 'H', 5]),
    ];

    it('names the unit skip on both surfaces instead of saying UNHCR has no rows', async () => {
      upstream([...ASYLUM_APPLICATION_ROWS, ...oddUnits]);
      const result = await runToolContract(getAsylumApplicationsTool, {
        origin: 'TIB',
        year_from: 2025,
      });
      const structured = structuredOf(result);
      expect(structured).toMatchObject({ rows: [], total_rows: 0, complete: true });
      const notice =
        'UNHCR returned 2 row(s), all with a unit code other than P (persons) or C (cases); they were left out rather than guessed.';
      expect(structured.notice).toBe(notice);
      expect(structured.data_notes).toContain(
        '2 upstream row(s) carried a unit code other than P (persons) or C (cases) and were left out.',
      );
      const text = textOf(result.content);
      expect(text).toContain(`> ${notice}`);
      for (const note of structured.data_notes as string[]) expect(text).toContain(note);
    });

    it('counts only the rows the stages filter kept, and names the filter', async () => {
      upstream([...ASYLUM_APPLICATION_ROWS, ...oddUnits]);
      const ctx = context();
      await call({ origin: 'TIB', year_from: 2025, stages: ['N'] }, ctx);
      expect(getEnrichment(ctx).notice).toBe(
        'UNHCR returned 1 row(s) matching stages=N, all with a unit code other than P (persons) or C (cases); they were left out rather than guessed.',
      );
    });
  });

  it('leaves out a unit code that names an Object.prototype member, on both surfaces', async () => {
    upstream([
      ...ASYLUM_APPLICATION_ROWS,
      // Illustrative: unit text a plain-object lookup would resolve through the prototype.
      applicationRow(2025, 'TIB', null, ['G', 'N', 'FI', 'constructor', 15]),
    ]);
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: 'TIB',
      year_from: 2025,
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], total_rows: 0, complete: true });
    const note =
      '1 upstream row(s) carried a unit code other than P (persons) or C (cases) and were left out.';
    expect(structured.data_notes).toContain(note);
    expect(textOf(result.content)).toContain(note);
  });

  it('reports a non-numeric count as null, never zero, and counts it in data_notes', async () => {
    const baseline = await call(syrDeu2025);
    upstream([
      ...ASYLUM_APPLICATION_ROWS,
      applicationRow(2025, 'SYR', 'DEU', ['G', 'BL', 'FI', 'P', 'n/a']),
    ]);
    const result = await call(syrDeu2025);
    expect(result.rows.find((row) => row.stages[0] === 'BL')).toMatchObject({ applied: null });
    const added = result.data_notes.filter((note) => !baseline.data_notes.includes(note));
    expect(added).toHaveLength(1);
    expect(textOf(getAsylumApplicationsTool.format!(result))).toContain(
      '| G | BL | FI | persons | — |',
    );
  });
});

describe('staging', () => {
  it('stages the code lists as comma-joined VARCHAR, unit as VARCHAR, and applied as INTEGER', async () => {
    const ctx = context();
    const result = await call({ origin: 'SYR', year_from: 2025, split_by: [], stage: true }, ctx);
    expect(result.dataset?.row_count).toBe(2);
    const { result: staged } = await getCanvasBridge()!.query(
      ctx,
      `SELECT unit, authorities, stages, decision_levels, applied, origin_unhcr_region,
         typeof(authorities) AS codes_type, typeof(unit) AS unit_type, typeof(applied) AS applied_type
       FROM ${result.dataset?.name} ORDER BY applied DESC`,
      { rowLimit: 10 },
    );
    expect(staged.rows).toEqual([
      {
        unit: 'persons',
        authorities: 'G,U',
        stages: 'A,J,N,NR,R,RA',
        decision_levels: 'AR,EO,FA,FI,JR,RA,TA',
        applied: 72000,
        origin_unhcr_region: 'Middle East and North Africa',
        codes_type: 'VARCHAR',
        unit_type: 'VARCHAR',
        applied_type: 'INTEGER',
      },
      expect.objectContaining({ unit: 'cases', authorities: 'G', stages: 'A,N', applied: 14 }),
    ]);
  });
});

describe('declared errors, by reason', () => {
  it('fails unknown_country_code for a name, before any data request', async () => {
    const error = errorOf(await runToolContract(getAsylumApplicationsTool, { origin: 'Syria' }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'unknown_country_code', codes: ['SYRIA'] });
    expect(error.data?.recovery?.hint).toContain('unhcr_list_reference');
    expect(dataRequests()).toHaveLength(0);
  });

  it('fails invalid_year_window without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getAsylumApplicationsTool, { year_from: 2025, year_to: 2024 }),
    );
    expect(error.data).toMatchObject({ reason: 'invalid_year_window' });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails year_out_of_coverage naming the asylum span, before the data', async () => {
    const error = errorOf(await runToolContract(getAsylumApplicationsTool, { year_to: 1999 }));
    expect(error.data).toMatchObject({
      reason: 'year_out_of_coverage',
      coverage: { first_year: 2000, latest_year: 2025 },
    });
    expect(error.data?.recovery?.hint).toContain('2000–2025');
    expect(dataRequests()).toHaveLength(0);
  });

  it('clamps a window that starts before the data, and says so', async () => {
    const ctx = context();
    const result = await call({ asylum: 'USA', year_from: 1990, year_to: 2015 }, ctx);
    expect(result.applied_scope).toMatchObject({ year_from: 2000, year_to: 2015 });
    expect(getEnrichment(ctx).notice).toContain('1990');
    expect(result.rows.map((row) => row.year)).toEqual([2015, 2015]);
  });

  it('fails conflicting_scope without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getAsylumApplicationsTool, { origin: 'SYR', expand: 'both' }),
    );
    expect(error.data).toMatchObject({ reason: 'conflicting_scope', conflicts: ['origin'] });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails upstream_busy with a retryAfter when UNHCR answers 429 on the data request', async () => {
    // A Retry-After past the 45 s call budget fails fast instead of waiting to retry.
    fake.intercept({
      endpoint: 'asylum-applications',
      matches: (params) => params.has('yearFrom'),
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '90' } }),
    });
    const error = errorOf(await runToolContract(getAsylumApplicationsTool, { origin: 'SYR' }));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_busy', retryable: true, retryAfter: 90 },
    });
    expect(error.data?.recovery?.hint).toBe(
      getAsylumApplicationsTool.errors?.find((entry) => entry.reason === 'upstream_busy')?.recovery,
    );
  });
});

describe('declared surface', () => {
  it('declares the five shared reasons, upstream_busy retryable, and read-only open-world annotations', () => {
    expect(getAsylumApplicationsTool.errors?.map((entry) => entry.reason).sort()).toEqual([
      'conflicting_scope',
      'invalid_year_window',
      'unknown_country_code',
      'upstream_busy',
      'year_out_of_coverage',
    ]);
    expect(
      getAsylumApplicationsTool.errors?.find((entry) => entry.reason === 'upstream_busy')
        ?.retryable,
    ).toBe(true);
    expect(getAsylumApplicationsTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('never routes callers to the drop tool, which is off by default', () => {
    const prose = JSON.stringify([
      getAsylumApplicationsTool.description,
      getAsylumApplicationsTool.errors,
      z.toJSONSchema(getAsylumApplicationsTool.input),
      z.toJSONSchema(getAsylumApplicationsTool.output),
    ]);
    expect(prose).not.toContain('unhcr_dataframe_drop');
  });
});
