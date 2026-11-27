/**
 * @fileoverview Reporting periods over the real tool contract and staged data.
 * @module tests/tools/reporting-periods.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getAsylumApplicationsTool } from '@/mcp-server/tools/definitions/get-asylum-applications.tool.js';
import { getAsylumDecisionsTool } from '@/mcp-server/tools/definitions/get-asylum-decisions.tool.js';
import { getDemographicsTool } from '@/mcp-server/tools/definitions/get-demographics.tool.js';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';
import { getSolutionsTool } from '@/mcp-server/tools/definitions/get-solutions.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  applicationRow,
  companionRow,
  decisionRow,
  NOWCAST_ROWS,
  populationRow,
  solutionsRow,
} from '../fixtures/unhcr.js';
import { flowContext, seededFrom, stagePopulation } from '../helpers/dataframes.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

const midYearRows = {
  population: [
    populationRow(2025, null, null, [500, 50, 24, 10, 9, 0, 0, 0, 0]),
    populationRow(2026, null, null, [600, 60, 12, 12, 6, 0, 0, 0, 0]),
  ],
  idmc: [companionRow(2025, null, null, 99), companionRow(2026, null, null, 99)],
  unrwa: [companionRow(2025, null, null, 61), companionRow(2026, null, null, 62)],
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T18:00:00Z'));
  initCanvasBridge(undefined);
});

afterEach(() => {
  disposeUnhcrService();
  vi.restoreAllMocks();
});

describe('statistical reporting periods', () => {
  it.each([
    ['August', 'UNHCR monthly nowcast: August 2026.', 'UNHCR monthly nowcast: August 2026.'],
    [
      null,
      'UNHCR monthly nowcast: 2026 (month unspecified).',
      'UNHCR monthly nowcast: 2026 (month unspecified).',
    ],
    [
      'August\n### injected ![x](https://example.org)',
      'UNHCR monthly nowcast: August\n### injected ![x](https://example.org) 2026.',
      'UNHCR monthly nowcast: August ### injected !\\[x\\](https://example.org) 2026.',
    ],
  ])(
    'keeps nowcast reporting context in a saved SQL projection (month %s)',
    async (month, period, rendered) => {
      vi.mocked(Date.now).mockRestore();
      const canvas = createTestCanvas();
      initCanvasBridge(canvas, { ttlMs: 60_000 });
      initFakeUpstream({
        tables: { ...midYearRows, nowcasting: NOWCAST_ROWS.map((row) => ({ ...row, month })) },
      });
      try {
        const ctx = flowContext();
        const population = await getPopulationTool.handler(
          getPopulationTool.input.parse({ year_from: 2027, include_nowcast: true, stage: true }),
          ctx,
        );
        const name = population.nowcast_dataset?.name;
        if (!name) throw new Error('Expected a staged nowcast');
        const describe = await runToolContract(seededFrom(dataframeDescribeTool, ctx), { name });
        expect(structuredOf(describe).dataframes).toMatchObject([{ name }]);
        expect(structuredOf(describe).dataframes).toMatchObject([{ reporting_periods: [period] }]);
        expect(textOf(describe.content)).toContain(rendered);

        const saved = await dataframeQueryTool.handler(
          dataframeQueryTool.input.parse({
            sql: `SELECT refugees FROM ${name}`,
            register_as: 'df_MONTH_00001',
          }),
          ctx,
        );
        expect(saved.reporting_periods).toEqual([period]);
        const projection = await runToolContract(seededFrom(dataframeQueryTool, ctx), {
          sql: 'SELECT refugees FROM df_MONTH_00001',
        });
        expect(structuredOf(projection)).toMatchObject({
          columns: ['refugees'],
          reporting_periods: [period],
        });
        expect(textOf(projection.content)).toContain(rendered);
        expect(textOf(projection.content)).not.toMatch(/\n### injected|June|December/);
      } finally {
        await shutdownCanvas(canvas);
      }
    },
  );

  it('reports the June release and independent companion periods on both surfaces', async () => {
    initFakeUpstream({ tables: midYearRows });
    const result = await runToolContract(getPopulationTool, { year_from: 2025 });
    const periods = [
      '2025 · UNHCR population: stocks at 31 December; returns from January through December.',
      '2026 · UNHCR population: stocks at 30 June; returns from January through June.',
      '2025 · UNRWA refugee registrations: year-end reporting period.',
      '2026 · UNRWA refugee registrations: June 2026 reporting period.',
      '2025 · IDMC conflict displacement: year-end stocks.',
      '2026 · IDMC conflict displacement: end-2025 stock carried forward.',
    ];
    expect(structuredOf(result).reporting_periods).toEqual(periods);
    for (const period of periods) expect(textOf(result.content)).toContain(period);
  });

  it('preserves captured periods after rollover through staged SQL descendants', async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-12-31T23:59:59Z'));
    const canvas = createTestCanvas();
    initCanvasBridge(canvas, { ttlMs: 60_000 });
    initFakeUpstream({ tables: midYearRows });
    try {
      const ctx = flowContext();
      const name = await stagePopulation(ctx, { year_from: 2026 });
      const period =
        '2026 · UNHCR population: stocks at 30 June; returns from January through June.';
      vi.mocked(Date.now).mockReturnValue(Date.parse('2027-01-01T00:00:00Z'));
      disposeUnhcrService();
      initFakeUpstream({
        tables: {
          ...midYearRows,
          population: [
            midYearRows.population[0]!,
            populationRow(2026, null, null, [910, 80, 29, 12, 8, 0, 0, 0, 0]),
          ],
        },
      });
      const latest = await runToolContract(getPopulationTool, { year_from: 2026 });
      expect(structuredOf(latest)).toMatchObject({
        rows: [{ year: 2026, refugees: 910 }],
        reporting_periods: expect.arrayContaining([
          '2026 · UNHCR population: reporting period unverified.',
        ]),
      });
      expect(textOf(latest.content)).toContain('reporting period unverified.');
      expect(textOf(latest.content)).not.toContain('31 December');
      const described = await runToolContract(seededFrom(dataframeDescribeTool, ctx), { name });
      expect(structuredOf(described).dataframes).toMatchObject([
        { reporting_periods: expect.arrayContaining([period]) },
      ]);
      expect(textOf(described.content)).toContain(period);

      // Saving two generations must retain the capture, even when the projection drops year.
      const args = (sql: string, register_as: string) =>
        dataframeQueryTool.input.parse({ sql, register_as });
      await dataframeQueryTool.handler(args(`SELECT refugees FROM ${name}`, 'df_FIRST_00001'), ctx);
      await dataframeQueryTool.handler(
        args('SELECT refugees FROM df_FIRST_00001', 'df_CHILD_00002'),
        ctx,
      );
      const pastEnd = await runToolContract(seededFrom(dataframeQueryTool, ctx), {
        sql: 'SELECT refugees FROM df_CHILD_00002 ORDER BY refugees OFFSET 2',
      });
      expect(structuredOf(pastEnd)).toMatchObject({
        rows: [],
        row_count: 0,
        complete: true,
        reporting_periods: expect.arrayContaining([period]),
      });
      expect(textOf(pastEnd.content)).toContain(period);
    } finally {
      await shutdownCanvas(canvas);
    }
  });

  it('does not attach periods to an empty data result or mask scope errors', async () => {
    initFakeUpstream({ tables: midYearRows });
    const empty = await runToolContract(getPopulationTool, { year_from: 2026, asylum: 'DEU' });
    expect(structuredOf(empty)).toMatchObject({ rows: [], reporting_periods: [], complete: true });
    expect(textOf(empty.content)).not.toContain('30 June');
    const pastCoverage = await runToolContract(getPopulationTool, { year_from: 2027 });
    expect(errorOf(pastCoverage)).toMatchObject({ data: { reason: 'year_out_of_coverage' } });
    expect(textOf(pastCoverage.content)).toContain('year_out_of_coverage');
  });

  it('reports period context for each UNHCR dataset while leaving demographics annual', async () => {
    initFakeUpstream({
      tables: {
        ...midYearRows,
        'asylum-applications': [applicationRow(2026, null, null, ['G', 'N', 'FI', 'P', 20])],
        'asylum-decisions': [decisionRow(2026, null, null, ['G', 'FI', 'P'], [1, 2, 3, 4, 10])],
        solutions: [solutionsRow(2026, null, null, [10, 20, 30, 40])],
      },
    });
    const results = await Promise.all([
      runToolContract(getAsylumApplicationsTool, { year_from: 2026 }),
      runToolContract(getAsylumDecisionsTool, { year_from: 2026 }),
      runToolContract(getSolutionsTool, { year_from: 2026 }),
      runToolContract(getDemographicsTool, { year_from: 2025 }),
      runToolContract(listReferenceTool, { topic: 'coverage' }),
    ]);
    const periods = [
      '2026 · UNHCR asylum applications: January through June.',
      '2026 · UNHCR asylum decisions: January through June.',
      '2026 · UNHCR durable solutions: January through June.',
      '2025 · UNHCR demographics: annual collection; stocks at 31 December and returns during the year.',
    ];
    for (const [index, result] of results.slice(0, 4).entries()) {
      expect(structuredOf(result).reporting_periods).toEqual([periods[index]]);
      expect(textOf(result.content)).toContain(periods[index]);
    }
    const reference = results[4];
    expect(structuredOf(reference).coverage).toEqual(
      expect.arrayContaining(
        periods.map((period) => expect.objectContaining({ latest_reporting_period: period })),
      ),
    );
    for (const period of periods) expect(textOf(reference.content)).toContain(period);
  });

  it('keeps the latest row year, aligned companion counts and a separate monthly nowcast', async () => {
    const { fake } = initFakeUpstream({ tables: midYearRows });
    const result = await runToolContract(getPopulationTool, {
      year_from: 2025,
      include_nowcast: true,
    });
    const output = structuredOf(result);

    expect(output).toMatchObject({
      latest_year: 2026,
      applied_scope: { year_from: 2025, year_to: 2026 },
      complete: true,
      total_rows: 2,
      rows: [
        { year: 2025, refugees: 500, idmc_conflict_idps: 99, unrwa_refugees: 61 },
        { year: 2026, refugees: 600, idmc_conflict_idps: 99, unrwa_refugees: 62 },
      ],
      nowcast: [{ year: 2026, month: 'August' }],
    });
    expect(fake.urlsFor('idmc')).toHaveLength(1);
    expect(fake.urlsFor('unrwa')).toHaveLength(1);
    expect(fake.urlsFor('demographics')).toHaveLength(0);
    expect(fake.urlsFor('population')).toHaveLength(3);
    expect(fake.urlsFor('footnotes')).toHaveLength(1);
    expect(textOf(result.content)).toContain('August 2026');
  });
});
