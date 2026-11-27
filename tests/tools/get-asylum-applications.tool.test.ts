/**
 * @fileoverview Tests for unhcr_get_asylum_applications over the fake UNHCR
 * upstream (recorded asylum-application rows) and a real in-memory DuckDB
 * canvas: both output surfaces on an under-cap, a zero-result, and an
 * over-cap page; cases never summed with persons (the US multi-unit series);
 * split_by grouping; the stages filter and its own empty-result notice; the
 * UNHCR caveats matched on the aggregated rows, and the footnote request that
 * fails the call with it; the unknown-unit skip; staged column types; every
 * declared error reason; and form-client blanks.
 * @module tests/tools/get-asylum-applications.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAsylumApplicationsTool } from '@/mcp-server/tools/definitions/get-asylum-applications.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { type ASYLUM_CODES, asylumCodeLabel } from '@/services/unhcr/codes.js';
import { disposeUnhcrService, getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  ASYLUM_APPLICATION_ROWS,
  applicationRow,
  COUNTRY_ROWS,
  envelope,
  FOOTNOTE_ROWS,
  footnoteRow,
  type RawRow,
  USA_2024_FOOTNOTE_TEXT,
  USA_APPLICATION_ROWS,
  USA_COUNTRY_ROW,
  USA_FOOTNOTE_ROWS,
} from '../fixtures/unhcr.js';
import { type FakeUnhcr, FOOTNOTE_FAULTS } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf, unescapeMarkdown } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

type Input = z.input<typeof getAsylumApplicationsTool.input>;

let canvas: DataCanvas;
let fake: FakeUnhcr;

/** Serve the recorded tables with the US in the country table, plus any overrides. */
const upstream = (applications?: RawRow[], footnotes?: RawRow[]) => {
  disposeUnhcrService();
  ({ fake } = initFakeUpstream({
    tables: {
      countries: [...COUNTRY_ROWS, USA_COUNTRY_ROW],
      ...(applications && { 'asylum-applications': applications }),
      ...(footnotes && { footnotes }),
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
  it.each([2_001])('discloses a clamped display request of %s on both surfaces', async (limit) => {
    const result = await runToolContract(getAsylumApplicationsTool, { origin: 'SYR', limit });
    const structured = structuredOf(result);
    expect(structured.notice).toContain(`Requested limit ${limit}; effective limit 2000.`);
    expect(textOf(result.content)).toContain(String(structured.notice));
    expect(structured).not.toHaveProperty('truncated');
  });
  it('logs a clamped limit under this tool’s name', async () => {
    const ctx = context();
    await call({ origin: 'SYR', limit: 2_001 }, ctx);
    const clampLines = (ctx.log as MockContextLogger).calls.filter(
      (line) => line.msg === 'Count input clamped',
    );
    expect(clampLines.map((line) => line.data)).toEqual([
      { tool: 'unhcr_get_asylum_applications', field: 'limit', requested: 2_001, effective: 2_000 },
    ]);
  });
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
    expect(structured).toMatchObject({
      rows: [],
      total_rows: 0,
      complete: true,
      footnotes: [],
      footnotes_total: 0,
    });
    expect(structured).not.toHaveProperty('dataset');
    expect(structured.notice).toContain('origin SYR in asylum TUR');
    const text = textOf(result.content);
    expect(text).toContain('**Rows:** 0 shown of 0 total');
    expect(text).toContain(
      '\n_No rows._\n\n**Footnotes:** none match (0 total)\n\n### Data notes\n',
    );
    expect(text).toContain(String(structured.notice));
  });

  it('names its own dataset in the one-country empty notice, on both surfaces', async () => {
    const result = await runToolContract(getAsylumApplicationsTool, { origin: 'TIB' });
    const structured = structuredOf(result);
    const notice =
      "UNHCR reports no asylum-application rows for TIB in 2000–2025. Widen the year window, or check the dataset's span with unhcr_list_reference (topic coverage).";
    expect(structured.total_rows).toBe(0);
    expect(structured.notice).toBe(notice);
    expect(textOf(result.content).split('\n')).toContain(`> ${notice}`);
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

  it('reads stages and split_by sent as strings as the arrays of their codes, on both surfaces', async () => {
    const scope: Input = { origin: 'SYR', asylum: 'DEU', year_from: 2025 };
    const strings = await runToolContract(getAsylumApplicationsTool, {
      ...scope,
      stages: 'n, R' as unknown as [],
      split_by: 'Stage authority' as unknown as [],
    });
    const rows = structuredOf(strings).rows as Row[];
    expect(rows.map((row) => [row.authorities, row.stages, row.applied])).toEqual([
      [['G'], ['N'], 23256],
      [['G'], ['R'], 984],
    ]);
    expect(textOf(strings.content)).toContain('| G | N | ');
    expect(strings).toEqual(
      await runToolContract(getAsylumApplicationsTool, {
        ...scope,
        stages: ['N', 'R'],
        split_by: ['stage', 'authority'],
      }),
    );
  });

  it('reads a stages string naming no code as no filter', async () => {
    const result = await call({ origin: 'SYR', year_from: 2025, stages: ',' as unknown as [] });
    expect(result.total_rows).toBe(8);
  });

  it('logs each list sent as a string under this tool’s name', async () => {
    const ctx = context();
    await call(
      { origin: 'SYR', stages: 'N' as unknown as [], split_by: 'stage' as unknown as [] },
      ctx,
    );
    const lines = (ctx.log as MockContextLogger).calls.filter(
      (line) => line.msg === 'List input normalized',
    );
    expect(lines.map((line) => line.data)).toEqual([
      { tool: 'unhcr_get_asylum_applications', field: 'split_by', effective: ['stage'] },
      { tool: 'unhcr_get_asylum_applications', field: 'stages', effective: ['N'] },
    ]);
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
    ['a string with an unknown stage code', { stages: 'N,ROC' as unknown as [] }],
    ['a split dimension this tool lacks', { split_by: ['unit'] as unknown as [] }],
    ['a split string with a dimension this tool lacks', { split_by: 'unit' as unknown as [] }],
    ['a split string naming no dimension', { split_by: ',' as unknown as [] }],
    ['more than three split entries', { split_by: ['stage', 'stage', 'stage', 'stage'] }],
    ['a sort field this tool lacks', { sort_by: 'recognized' as 'year' }],
    ['a fractional year', { year_from: 2020.5 }],
    ['a year below 1900', { year_to: 1899 }],
    ['limit 0', { limit: 0 }],
  ])('rejects %s as invalid params before any upstream request', async (_label, input) => {
    const result = await runToolContract(getAsylumApplicationsTool, input as Input);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('footnotes', () => {
  const usa = (input: Input): Input => ({ asylum: 'USA', ...input });
  const usaUpstream = () =>
    upstream([...ASYLUM_APPLICATION_ROWS, ...USA_APPLICATION_ROWS], USA_FOOTNOTE_ROWS);
  const matches = (result: Awaited<ReturnType<typeof call>>) =>
    result.footnotes.map((note) => [note.years, note.rows_matched]);

  it('attaches the half-year caveat to the 2024 row of the US new-application series, on both surfaces', async () => {
    usaUpstream();
    const result = await runToolContract(
      getAsylumApplicationsTool,
      usa({ year_from: 2023, year_to: 2024, split_by: [], stages: ['N'] }),
    );
    const structured = structuredOf(result);
    expect((structured.rows as Row[]).map(summary)).toEqual([
      [2023, 'persons', ['N'], 1176051],
      [2024, 'persons', ['N'], 729105],
    ]);
    expect(structured.footnotes).toEqual([
      {
        text: USA_2024_FOOTNOTE_TEXT,
        years: '2024',
        origin_iso3: null,
        asylum_iso3: 'USA',
        population_types: [
          'REF',
          'ROC',
          'ASY',
          'IDP',
          'IOC',
          'STA',
          'OOC',
          'RET',
          'RDP',
          'HST',
          'OIP',
          'RST',
          'NAT',
        ],
        rows_matched: 1,
      },
    ]);
    expect(structured.footnotes_total).toBe(1);
    expect((structured.data_notes as string[])[0]).toBe(
      'Counts are flows: asylum applications lodged during the reporting period. A footnote can narrow the period a row covers, so check the footnotes before comparing years.',
    );
    expect(textOf(result.content)).toContain(
      `\n\n### Footnotes (1 of 1)\n- **2024** · any origin, asylum USA · types REF, ROC, ASY, IDP, IOC, STA, OOC, RET, RDP, HST, OIP, RST, NAT · 1 rows matched\n\n> ${USA_2024_FOOTNOTE_TEXT}\n\n\n### Data notes\n- Counts are flows: asylum applications lodged during the reporting period. A footnote can narrow the period a row covers, so check the footnotes before comparing years.\n`,
    );
  });

  it('counts every row split by stage and unit in rows_matched: the US 2016–2025 series', async () => {
    usaUpstream();
    const result = await call(usa({ year_from: 2016, year_to: 2025 }));
    expect(result.rows).toHaveLength(24);
    expect(result.footnotes_total).toBe(9);
    expect(matches(result)).toEqual([
      ['2016', 2],
      ['2018 - 2019', 6],
      ['2020', 3],
      ['2021', 2],
      ['2022', 2],
      ['2024', 2],
      ['2025', 2],
      ['2019 - 2022', 10],
      ['2019 - 2022', 10],
    ]);
  });

  it('narrows the rows to the stages filter before matching', async () => {
    usaUpstream();
    const year2024 = { year_from: 2024, year_to: 2024 };
    expect(matches(await call(usa(year2024)))).toEqual([['2024', 2]]);
    expect(matches(await call(usa({ ...year2024, stages: ['A'] })))).toEqual([['2024', 1]]);
    // Appeals run 2017–2024, so the 2016 and 2025 caveats have no row left to attach to.
    expect(matches(await call(usa({ year_from: 2016, stages: ['A'] })))).toEqual([
      ['2018 - 2019', 2],
      ['2020', 1],
      ['2021', 1],
      ['2022', 1],
      ['2024', 1],
      ['2019 - 2022', 4],
      ['2019 - 2022', 4],
    ]);
    const emptied = await call(usa({ ...year2024, stages: ['R'] }));
    expect(emptied).toMatchObject({ rows: [], footnotes: [], footnotes_total: 0 });
  });

  it('carries ASY on a row whose count is 0 or null, and attaches no caveat tagged only with other types', async () => {
    const others = 'REF,ROC,OIP,IDP,IOC,STA,OOC,HST,RST,NAT,RET,RDP';
    const tibetNote = (population_type: string) =>
      footnoteRow({
        footnote: `${population_type} caveat.`,
        year: '2025',
        coo: 'TIB',
        coa: null,
        population_type,
      });
    upstream(
      [
        ...ASYLUM_APPLICATION_ROWS,
        // Illustrative: a published zero and a figure not collected.
        applicationRow(2025, 'TIB', null, ['G', 'N', 'FI', 'P', '0']),
        applicationRow(2025, 'TIB', null, ['G', 'A', 'AR', 'P', '-']),
      ],
      [...others.split(','), others, 'ASY'].map(tibetNote),
    );
    const result = await call({ origin: 'TIB', year_from: 2025 });
    expect(result.rows.map((row) => row.applied)).toEqual([null, 0]);
    expect(result.footnotes.map((note) => [note.text, note.rows_matched])).toEqual([
      ['ASY caveat.', 2],
    ]);
    expect(result.footnotes_total).toBe(1);
  });

  it('keeps the inline rows’ caveat ahead of a cap that caveats past the effective limit would fill, on both surfaces', async () => {
    const asylumNote = (asylum: string | null, footnote: string) =>
      footnoteRow({ footnote, year: '2025', coo: null, coa: asylum, population_type: 'ASY' });
    upstream(
      [
        ...ASYLUM_APPLICATION_ROWS.filter((row) => row.coo_iso === '-' && row.coa_iso === '-'),
        // Illustrative: 2,000 decision levels, so the split yields one row each.
        ...Array.from({ length: 2_000 }, (_, i) =>
          applicationRow(2025, 'SYR', 'DEU', ['G', 'N', `L${i}`, 'P', 10_000 + i]),
        ),
        applicationRow(2025, 'SYR', 'TUR', ['G', 'N', 'FI', 'P', 5]),
      ],
      [
        ...Array.from({ length: 21 }, (_, i) => asylumNote('TUR', `Türkiye caveat ${i}.`)),
        asylumNote(null, 'General caveat.'),
      ],
    );
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: 'SYR',
      expand: 'asylum',
      year_from: 2025,
      split_by: ['decision_level'],
      sort_by: 'applied',
      limit: 2_001,
    });
    const structured = structuredOf(result);
    // Türkiye's row sorts last, at position 2,000: past the effective limit of 2,000, inside the
    // 2,001 asked for, where its country-specific caveats would outrank the general one.
    expect(structured.rows).toHaveLength(2_000);
    expect(structured.footnotes_total).toBe(22);
    expect(
      (structured.footnotes as { rows_matched: number; text: string }[]).map((note) => [
        note.text,
        note.rows_matched,
      ]),
    ).toEqual([
      ['General caveat.', 2_001],
      ...Array.from({ length: 19 }, (_, i) => [`Türkiye caveat ${i}.`, 1]),
    ]);
    const text = textOf(result.content);
    expect(text).toContain('### Footnotes (20 of 22)\n- **2025** · any origin, any asylum');
    expect(text).toContain('\n> General caveat.\n');
    expect(text).not.toContain('Türkiye caveat 19.');
  });

  it('returns every caveat when they outnumber the inline rows, on both surfaces', async () => {
    const caveats = ['First caveat.', 'Second caveat.', 'Third caveat.'];
    upstream(
      undefined,
      caveats.map((footnote) =>
        footnoteRow({
          footnote,
          year: '2024 - 2025',
          coo: null,
          coa: 'DEU',
          population_type: 'ASY',
        }),
      ),
    );
    const result = await runToolContract(getAsylumApplicationsTool, {
      origin: 'SYR',
      asylum: 'DEU',
      limit: 1,
    });
    const structured = structuredOf(result);
    expect(structured.rows).toHaveLength(1);
    expect(structured.footnotes_total).toBe(3);
    expect((structured.footnotes as { text: string }[]).map((note) => note.text)).toEqual(caveats);
    const heading = '- **2024 - 2025** · any origin, asylum DEU · types ASY · 6 rows matched';
    expect(textOf(result.content)).toContain(
      `### Footnotes (3 of 3)\n${heading}\n\n> First caveat.\n\n${heading}\n\n> Second caveat.\n\n${heading}\n\n> Third caveat.\n`,
    );
  });

  it('rejects with the caller’s own cancellation while only the footnotes are in flight', async () => {
    const requested = Promise.withResolvers<void>();
    const held = Promise.withResolvers<Response>();
    fake.intercept({
      endpoint: 'footnotes',
      respond: () => {
        requested.resolve();
        return held.promise;
      },
    });
    const data = vi.spyOn(getUnhcrService(), 'asylumApplications');
    const controller = new AbortController();
    // The handler itself: the framework settles any aborted call as cancelled, whatever it returned.
    const pending = call(
      { origin: 'SYR', asylum: 'DEU' },
      createMockContext({ errors: getAsylumApplicationsTool.errors, signal: controller.signal }),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'caller went away',
    });
    await requested.promise;
    await expect(data.mock.results[0]?.value).resolves.toMatchObject({ complete: true });
    controller.abort(new DOMException('caller went away', 'AbortError'));
    await rejected;
    held.resolve(Response.json({ page: 1, maxPages: 1, items: FOOTNOTE_ROWS }));
  });

  /** Timers are faked, so the retry backoff and the 45 s call deadline run without a wait. */
  describe('their request', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      upstream();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('goes out while the data page is still on its way', async () => {
      const requested = Promise.withResolvers<void>();
      const held = Promise.withResolvers<Response>();
      fake.intercept({
        endpoint: 'asylum-applications',
        matches: (params) => params.has('yearFrom'),
        respond: () => {
          requested.resolve();
          return held.promise;
        },
      });
      const pending = runToolContract(getAsylumApplicationsTool, { origin: 'SYR', asylum: 'DEU' });
      await requested.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.urlsFor('footnotes')).toHaveLength(1);
      held.resolve(
        Response.json(envelope([applicationRow(2025, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', 5])])),
      );
      expect(structuredOf(await pending)).toMatchObject({ total_rows: 1 });
    });

    it.each(FOOTNOTE_FAULTS)(
      'fails the call on $fault, though the data page arrived',
      async ({ code, data, message, requests, respond }) => {
        const requested = Promise.withResolvers<void>();
        fake.intercept({
          endpoint: 'footnotes',
          respond: (request) => {
            requested.resolve();
            return respond(request);
          },
        });
        let settled = false;
        const pending = runToolContract(getAsylumApplicationsTool, { origin: 'SYR' }).finally(
          () => {
            settled = true;
          },
        );
        await requested.promise;
        await vi.advanceTimersByTimeAsync(44_999);
        // Only an answer that never comes holds the call to the end of its 45 s.
        expect(settled).toBe(code !== JsonRpcErrorCode.Timeout);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        const error = errorOf(result);
        expect(error.code).toBe(code);
        expect(error.message).toContain(message);
        expect(error.data).toEqual(data);
        expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
        expect(unescapeMarkdown(textOf(result.content))).toContain(message);
        expect(fake.urlsFor('footnotes')).toHaveLength(requests);
        expect(dataRequests()).toHaveLength(1);
      },
    );
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
  it('declares the six shared reasons, upstream_busy retryable, and read-only open-world annotations', () => {
    expect(getAsylumApplicationsTool.errors?.map((entry) => entry.reason).sort()).toEqual([
      'conflicting_scope',
      'invalid_year_window',
      'too_many_country_codes',
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
