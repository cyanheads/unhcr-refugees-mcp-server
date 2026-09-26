/**
 * @fileoverview Tests for unhcr_get_asylum_decisions over the fake UNHCR
 * upstream (recorded asylum-decision rows) and a real in-memory DuckDB canvas:
 * both output surfaces on an under-cap, a zero-result, and an over-cap page;
 * substantive decisions and both rates from summed counts, including a zero
 * denominator; cases never summed with persons (the US multi-unit series);
 * split_by grouping; the decision_levels filter and its own empty-result
 * notice; staged column types; every declared error reason; and form-client
 * blanks.
 * @module tests/tools/get-asylum-decisions.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAsylumDecisionsTool } from '@/mcp-server/tools/definitions/get-asylum-decisions.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { asylumCodeLabel } from '@/services/unhcr/codes.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  ASYLUM_DECISION_ROWS,
  COUNTRY_ROWS,
  decisionRow,
  type RawRow,
  USA_COUNTRY_ROW,
} from '../fixtures/unhcr.js';
import type { FakeUnhcr } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

type Input = z.input<typeof getAsylumDecisionsTool.input>;

let canvas: DataCanvas;
let fake: FakeUnhcr;

/** Serve the recorded tables with the US in the country table, plus any overrides. */
const upstream = (decisions?: RawRow[]) => {
  disposeUnhcrService();
  ({ fake } = initFakeUpstream({
    tables: {
      countries: [...COUNTRY_ROWS, USA_COUNTRY_ROW],
      ...(decisions && { 'asylum-decisions': decisions }),
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

const context = () => createMockContext({ errors: getAsylumDecisionsTool.errors });

const call = (input: Input, ctx = context()) =>
  getAsylumDecisionsTool.handler(getAsylumDecisionsTool.input.parse(input), ctx);

const dataRequests = () =>
  fake.urlsFor('asylum-decisions').filter((url) => url.searchParams.has('yearFrom'));

type Row = Awaited<ReturnType<typeof call>>['rows'][number];

/** Unit, substantive decisions, and the two rates of a row. */
const rates = (row: Row) => [
  row.unit,
  row.substantive_decisions,
  row.refugee_recognition_rate,
  row.total_protection_rate,
];

const syrPairs: Input = { origin: 'SYR', expand: 'asylum' };

describe('success, both surfaces', () => {
  it('returns an under-cap page through the production enrichment parse', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, { origin: 'SYR', asylum: 'DEU' });
    const structured = structuredOf(result);
    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('dataset');
    expect(structured).toMatchObject({
      total_rows: 2,
      complete: true,
      measure: 'flow',
      latest_year: 2025,
      applied_scope: {
        origin: { mode: 'listed', codes: ['SYR'] },
        asylum: { mode: 'listed', codes: ['DEU'] },
        year_from: 2000,
        year_to: 2025,
      },
      attribution: { providers: [] },
    });
    const rows = structured.rows as Row[];
    expect(rows[0]).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: 'DEU',
      asylum_unhcr_code: 'GFR',
      asylum_name: 'Germany',
      authorities: ['G'],
      decision_levels: ['FI', 'JR', 'RA'],
      unit: 'persons',
      recognized: 7291,
      complementary_protection: 70836,
      rejected: 3197,
      otherwise_closed: 24804,
      total_decisions: 106128,
      substantive_decisions: 81324,
      refugee_recognition_rate: 9,
      total_protection_rate: 96.1,
    });
    expect(rates(rows[1]!)).toEqual(['persons', 12374, 1.4, 5]);

    const text = textOf(result.content);
    for (const expected of [
      '**Measure:** flow · **Latest year:** 2025 · **Rows:** 2 shown of 2 total · **Complete:** yes',
      '| 2024 | Syrian Arab Rep. [SYR · UNHCR SYR] | Germany [DEU · UNHCR GFR] | G | FI, JR, RA | persons | 7,291 | 70,836 | 3,197 | 24,804 | 106,128 | 81,324 | 9.0% | 96.1% |',
      '| 2025 | Syrian Arab Rep. [SYR · UNHCR SYR] | Germany [DEU · UNHCR GFR] | G | FI, JR, RA | persons | 172 | 442 | 11,760 | 26,615 | 38,989 | 12,374 | 1.4% | 5.0% |',
      `FI ${asylumCodeLabel('decision_level', 'FI')}`,
      `JR ${asylumCodeLabel('decision_level', 'JR')}`,
      `G ${asylumCodeLabel('authority', 'G')}`,
      'Source: UNHCR Refugee Population Statistics Database (CC BY 4.0)',
    ]) {
      expect(text).toContain(expected);
    }
    for (const note of structured.data_notes as string[]) expect(text).toContain(note);
  });

  it('returns a zero-result page with the both-dimensions notice through the production enrichment parse', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, { origin: 'SYR', asylum: 'TUR' });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], total_rows: 0, complete: true });
    expect(structured.notice).toContain('origin SYR in asylum TUR');
    expect(textOf(result.content)).toContain(String(structured.notice));
  });

  it('returns an over-cap page with the truncation fields and the staged dataframe pointer', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, { ...syrPairs, limit: 3 });
    const structured = structuredOf(result);
    const dataset = structured.dataset as { name: string; row_count: number };
    expect(dataset.row_count).toBe(14);
    expect(structured).toMatchObject({ total_rows: 14, truncated: true, shown: 3, cap: 3 });
    expect((structured.rows as Row[]).map((row) => [row.year, row.asylum_iso3])).toEqual([
      [2024, 'AUT'],
      [2024, 'DEU'],
      [2024, 'GBR'],
    ]);
    expect(structured.notice).toContain(dataset.name);
    expect(textOf(result.content)).toContain('**Rows:** 3 shown of 14 total');
  });
});

describe('substantive decisions and rates', () => {
  it('nulls both rates when there are no substantive decisions, and renders them as dashes', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, { origin: 'SYR', asylum: 'MAR' });
    const rows = structuredOf(result).rows as Row[];
    expect(rows.map((row) => [row.year, row.otherwise_closed, ...rates(row)])).toEqual([
      [2024, 5, 'persons', 0, null, null],
      [2025, 63, 'persons', 0, null, null],
    ]);
    expect(textOf(result.content)).toContain('| persons | 0 | 0 | 0 | 63 | 63 | 0 | — | — |');
  });

  it('nulls substantive decisions and both rates when any outcome is null, and says so on both surfaces', async () => {
    upstream([
      ...ASYLUM_DECISION_ROWS,
      // Illustrative: "-" where a count is not applicable or not collected.
      decisionRow(2025, 'TIB', null, ['G', 'FI', 'P'], ['-', 10, 30, 5, 45]),
      decisionRow(2025, 'TIB', null, ['G', 'AR', 'P'], ['-', '-', '-', 5, 5]),
      decisionRow(2025, 'TIB', null, ['G', 'JR', 'P'], [20, 10, '-', 5, 35]),
    ]);
    const result = await runToolContract(getAsylumDecisionsTool, {
      origin: 'TIB',
      year_from: 2025,
      split_by: ['decision_level'],
    });
    const structured = structuredOf(result);
    expect(
      (structured.rows as Row[]).map((row) => [
        row.decision_levels,
        row.recognized,
        row.complementary_protection,
        row.rejected,
        ...rates(row),
      ]),
    ).toEqual([
      [['AR'], null, null, null, 'persons', null, null, null],
      [['FI'], null, 10, 30, 'persons', null, null, null],
      // Over recognized + complementary protection alone, the total protection rate would read 100%.
      [['JR'], 20, 10, null, 'persons', null, null, null],
    ]);
    const rateNote = (structured.data_notes as string[]).find((note) =>
      note.startsWith('refugee_recognition_rate ='),
    );
    expect(rateNote).toContain(
      'substantive_decisions = recognized + complementary_protection + rejected, and is null when any of the three is null',
    );
    expect(rateNote).toContain('null when substantive_decisions is 0 or null.');
    const text = textOf(result.content);
    expect(text).toContain('| G | FI | persons | — | 10 | 30 | 5 | 45 | — | — | — |');
    expect(text).toContain('| G | AR | persons | — | — | — | 5 | 5 | — | — | — |');
    expect(text).toContain('| G | JR | persons | 20 | 10 | — | 5 | 35 | — | — | — |');
    expect(text).toContain(
      '— marks null: not applicable or not collected, or a rate that cannot be computed (no substantive decisions, or a null count in it).',
    );
    expect(text).toContain(rateNote);
  });

  it('nulls substantive decisions and both rates when an outcome is null in any summed row, on both surfaces', async () => {
    upstream([
      ...ASYLUM_DECISION_ROWS,
      // Illustrative: "-" for rejected at one level, a number at the other.
      decisionRow(2025, 'TIB', null, ['G', 'FI', 'P'], [20, 10, '-', 5, 35]),
      decisionRow(2025, 'TIB', null, ['G', 'AR', 'P'], [5, 0, 15, 1, 21]),
    ]);
    const result = await runToolContract(getAsylumDecisionsTool, {
      origin: 'TIB',
      year_from: 2025,
    });
    const structured = structuredOf(result);
    // A denominator missing FI's rejections would put the rates at 50% and 70%.
    expect(
      (structured.rows as Row[]).map((row) => [
        row.decision_levels,
        row.recognized,
        row.complementary_protection,
        row.rejected,
        ...rates(row),
      ]),
    ).toEqual([[['AR', 'FI'], 25, 10, 15, 'persons', null, null, null]]);
    const rateNote = (structured.data_notes as string[]).find((note) =>
      note.startsWith('refugee_recognition_rate ='),
    );
    expect(rateNote).toContain(
      'is null when any of the three is null in any upstream row summed into it',
    );
    const text = textOf(result.content);
    expect(text).toContain('| G | AR, FI | persons | 25 | 10 | 15 | 6 | 56 | — | — | — |');
    expect(text).toContain(rateNote);
  });

  it('reports 0% rather than null when substantive decisions exist and none were recognized', async () => {
    const result = await call({ origin: 'SYR', asylum: 'UKR', year_from: 2025 });
    expect(result.rows.map(rates)).toEqual([['persons', 29, 0, 0]]);
    expect(textOf(getAsylumDecisionsTool.format!(result))).toContain('| 29 | 0.0% | 0.0% |');
  });

  it('never adds case-counted decisions to person-counted ones: the US series', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, { asylum: 'USA' });
    const rows = structuredOf(result).rows as Row[];
    expect(rows.map((row) => [row.year, row.decision_levels, ...rates(row)])).toEqual([
      [2015, ['EO'], 'persons', 17900, 45.1, 48.5],
      [2015, ['IN'], 'cases', 15588, 98.1, 98.1],
      [2016, ['EO'], 'persons', 21827, 42.6, 42.6],
      [2016, ['IN'], 'cases', 11282, 99.2, 99.2],
    ]);
    // A single 2015 row over both units would read 23379 recognized of 33488 substantive (69.8%).
    const text = textOf(result.content);
    expect(text).not.toContain('23,379');
    expect(text).not.toContain('69.8%');
    expect(text).toContain('| G | IN | cases | 15,298 |');
  });

  it('rates each unit on its own at world scope, where the year mixes them', async () => {
    const result = await call({ year_from: 2025 });
    expect(result.rows.map(rates)).toEqual([
      ['persons', 1538268, 32.2, 42.9],
      ['cases', 73183, 29.5, 29.5],
    ]);
  });

  it('keeps total_decisions as UNHCR’s published total where rounding sets it apart', async () => {
    const [row] = (await call({ year_to: 2000 })).rows;
    expect(row).toMatchObject({ year: 2000, unit: 'cases', total_decisions: 116851 });
    expect(
      (row?.recognized ?? 0) +
        (row?.complementary_protection ?? 0) +
        (row?.rejected ?? 0) +
        (row?.otherwise_closed ?? 0),
    ).toBe(116837);
  });
});

describe('split_by and decision_levels', () => {
  it('sums every level by default and lists them, with the level-summing caveat', async () => {
    const summed = await call({ origin: 'SYR', asylum: 'DEU', year_to: 2024 });
    const byLevel = await call({
      origin: 'SYR',
      asylum: 'DEU',
      year_to: 2024,
      split_by: ['decision_level'],
    });
    expect(byLevel.rows.map((row) => [row.decision_levels, ...rates(row)])).toEqual([
      [['FI'], 'persons', 77011, 9, 100],
      [['JR'], 'persons', 3453, 6.3, 8.1],
      [['RA'], 'persons', 860, 14.8, 99.4],
    ]);
    const caveat = summed.data_notes.filter((note) => !byLevel.data_notes.includes(note));
    expect(caveat).toHaveLength(1);
    expect(byLevel.data_notes.every((note) => summed.data_notes.includes(note))).toBe(true);
  });

  it('filters decision levels before summing, case-insensitively', async () => {
    const result = await call({ origin: 'SYR', decision_levels: ['fi'], year_to: 2024 });
    expect(result.rows).toEqual([
      expect.objectContaining({
        year: 2024,
        authorities: ['G', 'J', 'U'],
        decision_levels: ['FI'],
        recognized: 43220,
        complementary_protection: 73286,
        rejected: 2673,
        substantive_decisions: 119179,
        refugee_recognition_rate: 36.3,
        total_protection_rate: 97.8,
      }),
    ]);
  });

  it('splits by authority and decision level together', async () => {
    const result = await call({
      origin: 'SYR',
      year_to: 2024,
      decision_levels: ['FI'],
      split_by: ['authority', 'decision_level'],
    });
    expect(
      result.rows.map((row) => [row.authorities, row.decision_levels, row.recognized]),
    ).toEqual([
      [['G'], ['FI'], 42795],
      [['J'], ['FI'], 10],
      [['U'], ['FI'], 415],
    ]);
  });

  it('gives the decision_levels filter its own notice when it empties rows UNHCR returned', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, {
      origin: 'SYR',
      asylum: 'DEU',
      decision_levels: ['EO', 'in'],
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], total_rows: 0 });
    const notice = String(structured.notice);
    expect(notice).toContain('decision_levels');
    expect(notice).toContain('EO, IN');
    expect(notice).not.toContain('origin SYR in asylum DEU');
    expect(notice).not.toContain('UNHCR reports no');
    expect(textOf(result.content)).toContain(notice);
  });

  it('keeps the scope notice when UNHCR returned nothing, even with a decision_levels filter', async () => {
    const ctx = context();
    await call({ origin: 'SYR', asylum: 'TUR', decision_levels: ['FI'] }, ctx);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('origin SYR in asylum TUR');
    expect(notice).not.toContain('decision_levels');
  });

  it.each([
    ['recognized', ['AUT', 1290], ['DEU', 172]],
    ['rejected', ['DEU', 11760], ['GBR', 571]],
    ['substantive_decisions', ['DEU', 12374], ['AUT', 3906]],
    ['total_decisions', ['DEU', 38989], ['AUT', 4381]],
  ] as const)('sorts by %s largest first before the cut', async (sortBy, first, second) => {
    const result = await call({ ...syrPairs, year_from: 2025, sort_by: sortBy, limit: 2 });
    expect(result.total_rows).toBe(7);
    expect(result.rows.map((row) => [row.asylum_iso3, row[sortBy]])).toEqual([first, second]);
  });

  it('treats form-client blanks as unset: every level summed, no level filter, full coverage', async () => {
    const result = await runToolContract(getAsylumDecisionsTool, {
      origin: 'SYR',
      asylum: ' ',
      expand: '' as 'none',
      year_from: '' as unknown as number,
      year_to: '' as unknown as number,
      split_by: '' as unknown as [],
      decision_levels: '' as unknown as [],
      sort_by: ' ' as 'year',
    });
    const structured = structuredOf(result);
    expect(structured.applied_scope).toMatchObject({
      origin: { mode: 'listed', codes: ['SYR'] },
      asylum: { mode: 'summed', codes: [] },
      year_from: 2000,
      year_to: 2025,
    });
    expect((structured.rows as Row[]).map((row) => [row.year, row.decision_levels.length])).toEqual(
      [
        [2024, 8],
        [2025, 7],
      ],
    );
  });

  it.each([
    ['a rate as the sort field', { sort_by: 'refugee_recognition_rate' as 'year' }],
    ['an applications-only sort field', { sort_by: 'applied' as 'year' }],
    ['an unknown decision level', { decision_levels: ['ZZ'] }],
    ['an application-stage code', { decision_levels: ['V'] }],
    ['stage as a split dimension', { split_by: ['stage'] as unknown as [] }],
    ['more than two split entries', { split_by: ['authority', 'authority', 'authority'] }],
    ['a non-numeric year', { year_from: 'recent' as unknown as number }],
  ])('rejects %s as invalid params before any upstream request', async (_label, input) => {
    const result = await runToolContract(getAsylumDecisionsTool, input as Input);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('paging and the row cap', () => {
  it('sums counts and computes rates across every page of a multi-page walk', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({ pageSize: { 'asylum-decisions': 4 } }));
    const result = await call({ year_from: 2025 });
    expect(result.complete).toBe(true);
    expect(result.rows.map(rates)).toEqual([
      ['persons', 1538268, 32.2, 42.9],
      ['cases', 73183, 29.5, 29.5],
    ]);
    expect(dataRequests()).toHaveLength(4);
  });

  it('reports a fetch the row cap stopped as complete: false on both surfaces', async () => {
    disposeUnhcrService();
    ({ fake } = initFakeUpstream({
      pageSize: { 'asylum-decisions': 4 },
      config: { maxRows: 10_000 },
    }));
    const result = await runToolContract(getAsylumDecisionsTool, { year_from: 2025 });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ complete: false });
    // The first four upstream rows: three person-counted levels and one case-counted one.
    expect((structured.rows as Row[]).map((row) => [row.unit, row.decision_levels])).toEqual([
      ['persons', ['FA', 'FI']],
      ['cases', ['AR']],
    ]);
    const notice = String(structured.notice);
    expect(notice).toContain("The fetch stopped at the server's row cap after 4 upstream rows");
    const text = textOf(result.content);
    expect(text).toContain('**Complete:** no');
    expect(text).toContain(`> ${notice}`);
    expect(dataRequests()).toHaveLength(1);
  });
});

describe('odd upstream values', () => {
  it('leaves out a row whose unit is neither P nor C, and counts it in data_notes', async () => {
    const input: Input = { origin: 'SYR', asylum: 'DEU', year_from: 2025 };
    const baseline = await call(input);
    upstream([
      ...ASYLUM_DECISION_ROWS,
      // Illustrative: no recorded row carries a unit other than P or C.
      decisionRow(2025, 'SYR', 'DEU', ['G', 'FI', ''], [100, 100, 100, 100, 400]),
      decisionRow(2025, 'SYR', 'DEU', ['G', 'FI', 'H'], [100, 100, 100, 100, 400]),
    ]);
    const withOdd = await call(input);
    expect(withOdd.rows).toEqual(baseline.rows);
    const added = withOdd.data_notes.filter((note) => !baseline.data_notes.includes(note));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/\b2\b/);
  });

  describe('every row UNHCR returned has an unknown unit', () => {
    // Illustrative: no recorded row carries a unit other than P or C.
    const oddUnits = [
      decisionRow(2025, 'TIB', null, ['G', 'FI', ''], [5, 5, 5, 0, 15]),
      decisionRow(2025, 'TIB', null, ['G', 'AR', 'H'], [5, 5, 5, 0, 15]),
    ];

    it('names the unit skip on both surfaces instead of saying UNHCR has no rows', async () => {
      upstream([...ASYLUM_DECISION_ROWS, ...oddUnits]);
      const result = await runToolContract(getAsylumDecisionsTool, {
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

    it('counts only the rows the decision_levels filter kept, and names the filter', async () => {
      upstream([...ASYLUM_DECISION_ROWS, ...oddUnits]);
      const ctx = context();
      await call({ origin: 'TIB', year_from: 2025, decision_levels: ['FI'] }, ctx);
      expect(getEnrichment(ctx).notice).toBe(
        'UNHCR returned 1 row(s) matching decision_levels=FI, all with a unit code other than P (persons) or C (cases); they were left out rather than guessed.',
      );
    });
  });
});

describe('staging', () => {
  it('stages rates as DOUBLE, counts as INTEGER, and level lists as comma-joined VARCHAR', async () => {
    const ctx = context();
    const result = await call({ origin: 'SYR', asylum: 'DEU', stage: true }, ctx);
    const name = result.dataset?.name;
    const bridge = getCanvasBridge()!;
    const { result: staged } = await bridge.query(
      ctx,
      `SELECT year, decision_levels, unit, recognized, substantive_decisions, refugee_recognition_rate,
         total_protection_rate, typeof(decision_levels) AS levels_type,
         typeof(refugee_recognition_rate) AS rate_type, typeof(recognized) AS count_type
       FROM ${name} ORDER BY year`,
      { rowLimit: 10 },
    );
    expect(staged.rows[0]).toEqual({
      year: 2024,
      decision_levels: 'FI,JR,RA',
      unit: 'persons',
      recognized: 7291,
      substantive_decisions: 81324,
      refugee_recognition_rate: 9,
      total_protection_rate: 96.1,
      levels_type: 'VARCHAR',
      rate_type: 'DOUBLE',
      count_type: 'INTEGER',
    });
    // Across rows, the rate comes back from summed counts: 7463 of 93698, not the mean of 9.0 and 1.4.
    const { result: pooled } = await bridge.query(
      ctx,
      `SELECT ROUND(CAST(SUM(recognized) AS DOUBLE) / SUM(substantive_decisions) * 100, 1) AS rate FROM ${name}`,
      { rowLimit: 1 },
    );
    expect(pooled.rows).toEqual([{ rate: 8 }]);
  });

  it('adds the SQL rate note to data_notes only when the result was staged', async () => {
    const inline = await call({ origin: 'SYR', asylum: 'DEU' });
    const staged = await call({ origin: 'SYR', asylum: 'DEU', stage: true });
    expect(staged.dataset).toBeDefined();
    const added = staged.data_notes.filter((note) => !inline.data_notes.includes(note));
    expect(added).toHaveLength(1);
    // A row with a null outcome has a null denominator, so SUM(recognized) must skip it too.
    expect(added[0]).toContain('over rows where substantive_decisions is not null');
    expect(inline.data_notes.every((note) => staged.data_notes.includes(note))).toBe(true);
  });
});

describe('a country list encoded into a string', () => {
  it.each([
    [
      'asylum',
      { origin: 'SYR', asylum: '["DEU","AUT"]' },
      { origin: 'SYR', asylum: ['DEU', 'AUT'] },
      ['DEU', 'AUT'],
    ],
    ['origin', { origin: '["SYR"]' }, { origin: ['SYR'] }, ['SYR']],
  ] as const)(
    'reads a JSON-encoded %s list as its codes, matching the array form on both surfaces',
    async (dimension, encoded, list, codes) => {
      const window = { year_from: 2024, year_to: 2024 };
      const fromString = await runToolContract(getAsylumDecisionsTool, { ...encoded, ...window });
      const fromArray = await runToolContract(getAsylumDecisionsTool, { ...list, ...window });
      const structured = structuredOf(fromString);
      expect(structured.applied_scope).toMatchObject({
        [dimension]: { mode: 'listed', codes },
      });
      expect(structured.total_rows).toBeGreaterThan(0);
      expect(structured).toEqual(structuredOf(fromArray));
      expect(textOf(fromString.content)).toBe(textOf(fromArray.content));
    },
  );

  it('names only the rejected code when an encoded list holds one', async () => {
    const error = errorOf(
      await runToolContract(getAsylumDecisionsTool, { asylum: '["DEU","GFR"]' }),
    );
    expect(error.data).toMatchObject({ reason: 'unknown_country_code', codes: ['GFR'] });
    expect(error.message).toBe("Not an ISO3 code in UNHCR's country list: asylum GFR.");
    expect(error.data?.recovery?.hint).toContain('pass DEU');
  });
});

describe('declared errors, by reason', () => {
  it('fails unknown_country_code with the exact ISO3 for a UNHCR code', async () => {
    const error = errorOf(await runToolContract(getAsylumDecisionsTool, { asylum: 'GFR' }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'unknown_country_code', codes: ['GFR'] });
    expect(error.data?.recovery?.hint).toContain('DEU');
    expect(dataRequests()).toHaveLength(0);
  });

  it('fails invalid_year_window without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getAsylumDecisionsTool, { year_from: 2010, year_to: 2005 }),
    );
    expect(error.data).toMatchObject({ reason: 'invalid_year_window', year_from: 2010 });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails year_out_of_coverage for a window after the latest year, naming the span', async () => {
    const error = errorOf(await runToolContract(getAsylumDecisionsTool, { year_from: 2026 }));
    expect(error.data).toMatchObject({
      reason: 'year_out_of_coverage',
      coverage: { first_year: 2000, latest_year: 2025 },
    });
    expect(error.data?.recovery?.hint).toContain('2000–2025');
    expect(error.data?.recovery?.hint).not.toContain('include_nowcast');
    expect(dataRequests()).toHaveLength(0);
  });

  it('fails conflicting_scope without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getAsylumDecisionsTool, { asylum: 'DEU', expand: 'asylum' }),
    );
    expect(error.data).toMatchObject({ reason: 'conflicting_scope', conflicts: ['asylum'] });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails upstream_busy with a retryAfter when UNHCR answers 429 on the data request', async () => {
    // A Retry-After past the 45 s call budget fails fast instead of waiting to retry.
    fake.intercept({
      endpoint: 'asylum-decisions',
      matches: (params) => params.has('yearFrom'),
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    });
    const error = errorOf(await runToolContract(getAsylumDecisionsTool, { origin: 'SYR' }));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_busy', retryable: true, retryAfter: 120 },
    });
    expect(error.data?.recovery?.hint).toBe(
      getAsylumDecisionsTool.errors?.find((entry) => entry.reason === 'upstream_busy')?.recovery,
    );
  });
});

describe('declared surface', () => {
  it('declares the five shared reasons, upstream_busy retryable, and read-only open-world annotations', () => {
    expect(getAsylumDecisionsTool.errors?.map((entry) => entry.reason).sort()).toEqual([
      'conflicting_scope',
      'invalid_year_window',
      'unknown_country_code',
      'upstream_busy',
      'year_out_of_coverage',
    ]);
    expect(
      getAsylumDecisionsTool.errors?.find((entry) => entry.reason === 'upstream_busy')?.retryable,
    ).toBe(true);
    expect(getAsylumDecisionsTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('never routes callers to the drop tool, which is off by default', () => {
    const prose = JSON.stringify([
      getAsylumDecisionsTool.description,
      getAsylumDecisionsTool.errors,
      z.toJSONSchema(getAsylumDecisionsTool.input),
      z.toJSONSchema(getAsylumDecisionsTool.output),
    ]);
    expect(prose).not.toContain('unhcr_dataframe_drop');
  });
});
