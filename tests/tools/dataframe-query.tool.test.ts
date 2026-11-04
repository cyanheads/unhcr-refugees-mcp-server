/**
 * @fileoverview Tests for unhcr_dataframe_query over a real in-memory DuckDB
 * canvas: results on both surfaces, the enrichment contract on empty,
 * under-cap, capped, and previewed pages, the preview and row_limit defaults
 * and clamps (the canvas row cap included), attribution carried from the
 * staged dataframes, register_as and the staging budget's evictions, every
 * declared error reason, and cell escaping.
 * @module tests/tools/dataframe-query.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import {
  dataframeQueryTool,
  defineDataframeQueryTool,
} from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { TERMS_URL } from '@/services/unhcr/codes.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { carryDataframeState, flowContext, stagePopulation } from '../helpers/dataframes.js';
import { errorOf, structuredOf, textOf, unescapeMarkdown } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

type Input = z.input<typeof dataframeQueryTool.input>;

let canvas: DataCanvas;

beforeAll(() => {
  canvas = createTestCanvas();
});

afterAll(async () => {
  await shutdownCanvas(canvas);
});

beforeEach(() => {
  initFakeUpstream();
  initCanvasBridge(canvas, { ttlMs: 60_000 });
});

afterEach(() => {
  disposeUnhcrService();
});

const queryIn = (ctx: ReturnType<typeof flowContext>, input: Input) =>
  dataframeQueryTool.handler(dataframeQueryTool.input.parse(input), ctx);

/** The query tool running against the dataframes an earlier call staged. */
const querySeededFrom = (source: ReturnType<typeof flowContext>): typeof dataframeQueryTool => ({
  ...dataframeQueryTool,
  handler: async (input, ctx) => {
    await carryDataframeState(source, ctx);
    return dataframeQueryTool.handler(input, ctx);
  },
});

const recoveryFor = (reason: string) =>
  dataframeQueryTool.errors?.find((entry) => entry.reason === reason)?.recovery;

describe('pages through the production enrichment parse', () => {
  it('characterizes literal query nesting without changing result values', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT * FROM query('SELECT 7 AS n')",
    });
    expect(structuredOf(result).rows).toEqual([{ n: 7 }]);
    expect(textOf(result.content)).toContain('| 7 |');
  });

  it('returns an empty result with its notice and the attribution line', async () => {
    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1 AS n WHERE false' });
    expect(structuredOf(result)).toEqual({
      complete: true,
      incomplete_sources: [],
      columns: ['n'],
      row_count: 0,
      row_count_capped: false,
      rows: [],
      attribution: {
        source: 'UNHCR Refugee Population Statistics Database',
        license: 'CC BY 4.0',
        terms_url: TERMS_URL,
        providers: [],
      },
      notice:
        'Query returned 0 rows. Check the dataframe names and columns with unhcr_dataframe_describe, and whether the filters or joins in the query exclude every row.',
    });
    const text = textOf(result.content);
    expect(text).toContain('**0 rows**');
    expect(text).toContain('_No rows._');
    expect(text).toContain(
      `Source: UNHCR Refugee Population Statistics Database (CC BY 4.0); terms: ${TERMS_URL}.`,
    );
  });

  it('returns an under-cap page with no truncation fields', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(n, s)",
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      columns: ['n', 's'],
      row_count: 2,
      row_count_capped: false,
      rows: [
        { n: 1, s: 'a' },
        { n: 2, s: 'b' },
      ],
    });
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('notice');
    const text = textOf(result.content);
    expect(text).toContain('**2 rows**');
    expect(text).toContain('| n | s |\n| --- | --- |\n| 1 | a |\n| 2 | b |');
  });

  it('flags a result capped at row_limit and says how to keep the rest', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM (VALUES (1), (2), (3)) t(n)',
      row_limit: 2,
    });
    expect(structuredOf(result)).toMatchObject({
      row_count: 2,
      row_count_capped: true,
      truncated: true,
      shown: 2,
      cap: 2,
      notice:
        'Showing 2 rows. More than row_limit (2) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or raise row_limit (max 10000).',
    });
    expect(textOf(result.content)).toContain('**2 rows** — capped at row_limit; more rows matched');
  });

  it('reports rows withheld by preview against the preview cap', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM (VALUES (1), (2), (3)) t(n)',
      preview: 1,
    });
    expect(structuredOf(result)).toMatchObject({
      row_count: 3,
      row_count_capped: false,
      rows: [{ n: 1 }],
      truncated: true,
      shown: 1,
      cap: 1,
      notice:
        'Showing 1 of 3 rows. Use register_as to keep the whole result, or raise preview (max 1000).',
    });
    expect(textOf(result.content)).toContain('**3 rows**, showing 1');
  });

  it.each([
    ['row_limit', { row_limit: 2 }, [{ n: 1 }, { n: 2 }]],
    ['preview', { preview: 0 }, []],
  ] as const)(
    'points at the saved table when register_as keeps what %s withholds, on both surfaces',
    async (_lever, bound, rows) => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT * FROM (VALUES (1), (2), (3)) t(n)',
        register_as: 'df_SAVED_00003',
        ...bound,
      });
      const notice = `Showing ${rows.length} of 3 rows; the full result is saved as df_SAVED_00003, so query it for the rest.`;
      expect(structuredOf(result)).toMatchObject({
        registered_as: 'df_SAVED_00003',
        row_count: 3,
        row_count_capped: false,
        rows,
        truncated: true,
        shown: rows.length,
        cap: rows.length,
        notice,
      });
      const text = textOf(result.content);
      expect(text).toContain('Registered as df_SAVED_00003');
      expect(text).toContain(notice);
      expect(text).not.toContain('Use register_as');
    },
  );
});

describe('count inputs', () => {
  /** 300 rows of about 1 KB each: the rows returned follow preview, never row width. */
  const WIDE_ROWS =
    "SELECT n, repeat('x', 1000) AS pad FROM (SELECT unnest(generate_series(1, 300)) AS n)";
  const NARROW_ROWS = (count: number) => `SELECT unnest(generate_series(1, ${count})) AS n`;

  it.each([
    [200, 200],
    [undefined, 25],
  ])('returns exactly preview rows of wide rows (preview %s → %s)', async (preview, shown) => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: WIDE_ROWS,
      ...(preview !== undefined && { preview }),
    });
    const structured = structuredOf(result);
    expect(structured.rows).toHaveLength(shown);
    expect(structured).toMatchObject({ row_count: 300, truncated: true, shown, cap: shown });
    expect(structured.notice).toBe(
      `Showing ${shown} of 300 rows. Use register_as to keep the whole result, or raise preview (max 1000).`,
    );
    // Plain labels and cells render as a Markdown table: one line per row.
    const tableRows = textOf(result.content)
      .split('\n')
      .filter((line) => line.endsWith(` | ${'x'.repeat(1000)} |`));
    expect(tableRows).toHaveLength(shown);
  });

  it('returns a 600,000-character cell whole on both surfaces', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT repeat('x',600000) AS long_cell",
      preview: 1,
    });
    const cell = 'x'.repeat(600_000);
    expect(structuredOf(result).rows).toEqual([{ long_cell: cell }]);
    // The underscore in long_cell is outside the plain-label set, so the result renders as fenced JSON.
    const encoded = textOf(result.content).split('```json\n')[1]?.split('\n```')[0];
    expect(JSON.parse(encoded ?? '')).toEqual({
      columns: ['long_cell'],
      rows: [{ long_cell: cell }],
    });
  });

  it('returns columns and completeness with no rows at preview 0', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(n, s)",
      preview: 0,
    });
    expect(structuredOf(result)).toMatchObject({
      columns: ['n', 's'],
      complete: true,
      incomplete_sources: [],
      row_count: 2,
      rows: [],
      truncated: true,
      shown: 0,
    });
    const text = textOf(result.content);
    expect(text).toContain('Complete: true. Incomplete sources: none.');
    expect(text).toContain('Columns: n, s');
  });

  it.each([
    [
      'preview',
      { preview: 1_501, row_limit: 2_000 },
      1_500,
      'Requested preview 1501; effective preview 1500.',
    ],
    [
      'row_limit',
      { row_limit: 10_001 },
      25,
      'Requested row_limit 10001; effective row_limit 10000.',
    ],
  ] as const)(
    'clamps %s above its cap with a notice on both surfaces',
    async (_field, bound, shown, notice) => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: NARROW_ROWS(2_000),
        ...bound,
      });
      const structured = structuredOf(result);
      expect(structured.rows).toHaveLength(shown);
      expect(structured.notice).toContain(notice);
      expect(unescapeMarkdown(textOf(result.content))).toContain(notice);
    },
  );

  it('logs each clamp under this tool’s name and the field it clamped', async () => {
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: NARROW_ROWS(3), preview: 1_501, row_limit: 10_001 }),
      ctx,
    );
    const clampLines = (ctx.log as MockContextLogger).calls.filter(
      (line) => line.msg === 'Count input clamped',
    );
    expect(clampLines.map((line) => line.data)).toEqual([
      { tool: 'unhcr_dataframe_query', field: 'row_limit', requested: 10_001, effective: 10_000 },
      { tool: 'unhcr_dataframe_query', field: 'preview', requested: 1_501, effective: 1_500 },
    ]);
  });

  it('leaves preview 1500 and row_limit 10000 unclamped', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: NARROW_ROWS(1_500),
      preview: 1_500,
      row_limit: 10_000,
    });
    const structured = structuredOf(result);
    expect(structured.rows).toHaveLength(1_500);
    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('truncated');
  });

  it.each([
    [1_500, ''],
    [10_000, 'Requested preview 10000; effective preview 1500. '],
  ])(
    'offers paging, not a preview lever, once preview %s is served at its 1,500 cap',
    async (requested, clampNotice) => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: NARROW_ROWS(1_600),
        preview: requested,
        row_limit: 10_000,
      });
      const notice = `${clampNotice}Showing 1500 of 1600 rows. Use register_as to keep the whole result, or page through it with LIMIT and OFFSET.`;
      expect(structuredOf(result)).toMatchObject({
        row_count: 1_600,
        row_count_capped: false,
        truncated: true,
        shown: 1_500,
        cap: 1_500,
        notice,
      });
      expect(unescapeMarkdown(textOf(result.content))).toContain(notice);
    },
  );

  it.each([
    [{}, 25, 1_000],
    [{ preview: 1_500 }, 1_000, 1_000],
  ] as const)(
    'points a result capped at row_limit at row_limit, not preview (%o)',
    async (bound, shown, rowLimit) => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: NARROW_ROWS(1_200),
        ...bound,
      });
      const structured = structuredOf(result);
      expect(structured).toMatchObject({ row_count: rowLimit, row_count_capped: true, shown });
      const lever = `Showing ${shown} rows. More than row_limit (${rowLimit}) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or raise row_limit (max 10000).`;
      expect(structured.notice).toContain(lever);
      expect(structured.notice).not.toContain('raise preview');
      expect(unescapeMarkdown(textOf(result.content))).toContain(lever);
    },
  );

  it('offers paging once row_limit is at its cap and the result is still capped', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: NARROW_ROWS(10_001),
      preview: 0,
      row_limit: 10_000,
    });
    expect(structuredOf(result)).toMatchObject({ row_count: 10_000, row_count_capped: true });
    expect(structuredOf(result).notice).toBe(
      'Showing 0 rows. More than row_limit (10000) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or page through it with LIMIT and OFFSET.',
    );
  });

  it('holds row_limit to a canvas row cap of 500: omitted it defaults to 500, and 1000 clamps to 500', async () => {
    const small = createTestCanvas(500);
    initCanvasBridge(small, { ttlMs: 60_000 });
    try {
      const capped = defineDataframeQueryTool({ clamp: true, rowLimitCap: 500 });
      expect(capped.input.parse({ sql: 'SELECT 1' }).row_limit).toBe(500);
      // row_limit is already at the canvas cap, so the notice offers paging, not a lever it cannot pull.
      const omitted = await runToolContract(capped, { sql: NARROW_ROWS(600), preview: 500 });
      expect(structuredOf(omitted)).toMatchObject({ row_count: 500, row_count_capped: true });
      expect(structuredOf(omitted).notice).toBe(
        'Showing 500 rows. More than row_limit (500) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or page through it with LIMIT and OFFSET.',
      );
      expect(unescapeMarkdown(textOf(omitted.content))).toContain(
        'or page through it with LIMIT and OFFSET.',
      );
      expect(textOf(omitted.content)).not.toContain('raise');

      // Below the cap row_limit is the lever; preview cannot show rows past it.
      const preview = await runToolContract(capped, { sql: NARROW_ROWS(600), row_limit: 400 });
      expect(structuredOf(preview).notice).toBe(
        'Showing 25 rows. More than row_limit (400) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or raise row_limit (max 500).',
      );

      // Not capped, preview's ceiling is row_limit when that is below 1,500.
      const ceiling = await runToolContract(capped, { sql: NARROW_ROWS(300) });
      expect(structuredOf(ceiling).notice).toBe(
        'Showing 25 of 300 rows. Use register_as to keep the whole result, or raise preview (max 500).',
      );

      const over = await runToolContract(capped, { sql: NARROW_ROWS(600), row_limit: 1_000 });
      expect(structuredOf(over)).toMatchObject({ row_count: 500, row_count_capped: true });
      expect(structuredOf(over).notice).toContain(
        'Requested row_limit 1000; effective row_limit 500.',
      );
    } finally {
      await shutdownCanvas(small);
    }
  });

  it.each([false, true])(
    'composes source, clamp and saved-table disclosures (register_as %s)',
    async (saved) => {
      disposeUnhcrService();
      initFakeUpstream({ pageSize: { population: 2 }, config: { maxRows: 10_000 } });
      const flow = flowContext();
      const name = await stagePopulation(flow, {
        origin: 'SYR',
        expand: 'asylum',
        year_from: 2025,
      });
      const result = await runToolContract(querySeededFrom(flow), {
        sql: `SELECT year FROM ${name} CROSS JOIN (SELECT unnest(generate_series(1, 3)) AS k)`,
        row_limit: 1,
        preview: 10_001,
        ...(saved && { register_as: 'df_COMBO_00001' }),
      });
      const structured = structuredOf(result);
      expect(structured).toMatchObject({
        complete: false,
        incomplete_sources: [name],
        row_count_capped: !saved,
        truncated: true,
      });
      expect(structured.rows).toHaveLength(1);
      for (const fragment of [
        'Requested preview 10001; effective preview 1.',
        `This result is partial: upstream fetches for ${name} stopped before completion.`,
        saved ? 'the full result is saved as df_COMBO_00001' : 'Use register_as',
      ]) {
        expect(structured.notice).toContain(fragment);
        expect(unescapeMarkdown(textOf(result.content))).toContain(fragment);
      }
      if (saved) expect(textOf(result.content)).not.toContain('Use register_as');
    },
  );

  it('names no byte budget, result chunks, or withheld metadata anywhere it speaks', () => {
    const surface = JSON.stringify([
      dataframeQueryTool.description,
      dataframeQueryTool.errors,
      dataframeQueryTool.enrichment &&
        Object.values(dataframeQueryTool.enrichment).map((field) => field.description),
      z.toJSONSchema(dataframeQueryTool.input),
      z.toJSONSchema(dataframeQueryTool.output),
    ]);
    for (const term of ['result_chunks', 'metadata_withheld', 'result_storage_unavailable', 'byte'])
      expect(surface, term).not.toContain(term);
  });
});

describe('staged dataframes', () => {
  it.each(['query', 'QuErY', '"query"', 'query /* comment */', 'query -- comment\n'])(
    'retains incomplete root sources through %s and saved descendants',
    async (queryFunction) => {
      disposeUnhcrService();
      initFakeUpstream({ pageSize: { population: 2 }, config: { maxRows: 10_000 } });
      const flow = flowContext();
      const name = await stagePopulation(flow, {
        origin: 'SYR',
        expand: 'asylum',
        year_from: 2025,
      });
      const first = await queryIn(flow, {
        sql: `SELECT count(*) AS n FROM ${queryFunction}('SELECT * FROM "${name.toLowerCase()}"')`,
        register_as: 'df_CHILD_00001',
      });
      expect(first).toMatchObject({ complete: false, incomplete_sources: [name] });
      const child = await runToolContract(querySeededFrom(flow), {
        sql: 'SELECT * FROM df_CHILD_00001 WHERE false',
        preview: 0,
      });
      expect(structuredOf(child)).toMatchObject({
        complete: false,
        incomplete_sources: [name],
        rows: [],
      });
      expect(structuredOf(child).notice).toContain(name);
      expect(textOf(child.content)).toContain(name);
    },
  );
  it('queries a staged result and credits the companion series it carries', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { asylum: 'JOR' });
    const result = await runToolContract(querySeededFrom(flow), {
      sql: `SELECT year, refugees, unrwa_refugees, asylum_unhcr_region FROM ${name} ORDER BY year`,
    });
    const structured = structuredOf(result);
    expect(structured.rows).toEqual([
      {
        year: 2023,
        refugees: 684066,
        unrwa_refugees: 2392531,
        asylum_unhcr_region: 'Middle East and North Africa',
      },
      {
        year: 2024,
        refugees: 643641,
        unrwa_refugees: 2371387,
        asylum_unhcr_region: 'Middle East and North Africa',
      },
      {
        year: 2025,
        refugees: 436226,
        unrwa_refugees: 2398179,
        asylum_unhcr_region: 'Middle East and North Africa',
      },
    ]);
    expect(structured.attribution).toMatchObject({ providers: ['UNRWA'] });
    expect(textOf(result.content)).toContain('Includes third-party series: UNRWA.');
  });

  it('unions the providers of every dataframe a join references', async () => {
    const flow = flowContext();
    const jordan = await stagePopulation(flow, { asylum: 'JOR' });
    const syria = await stagePopulation(flow, { origin: 'SYR' });
    const result = await queryIn(flow, {
      sql: `SELECT a.year FROM ${jordan} a JOIN ${syria} b USING (year)`,
    });
    expect(result.attribution.providers).toEqual(['IDMC', 'UNRWA']);
  });

  it('returns SUM results as the JSON strings DuckDB gives BIGINTs', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR', expand: 'asylum', year_from: 2025 });
    const result = await queryIn(flow, {
      sql: `SELECT asylum_unhcr_region AS region, SUM(refugees) AS refugees FROM ${name} GROUP BY 1 ORDER BY 1`,
    });
    expect(result.rows).toEqual([
      { region: 'Europe', refugees: '3016403' },
      { region: 'Middle East and North Africa', refugees: '953192' },
    ]);
  });

  it('saves a result under register_as with a fresh TTL, visible to describe', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR' });
    const result = await queryIn(flow, {
      sql: `SELECT year, refugees FROM ${name} WHERE year >= 2024`,
      register_as: 'df_SYRIA_00024',
    });
    expect(result).toMatchObject({ registered_as: 'df_SYRIA_00024', row_count: 2 });
    expect(result.expires_at).toEqual(expect.any(String));
    expect(textOf(dataframeQueryTool.format!(result))).toContain(
      `Registered as df_SYRIA_00024 (expires ${result.expires_at}).`,
    );
    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: 'df_SYRIA_00024' }),
      flow,
    );
    expect(described.dataframes[0]).toMatchObject({
      source_tool: 'unhcr_dataframe_query',
      providers: ['IDMC'],
      row_count: 2,
      complete: true,
    });
  });

  it('names the dataframes a register_as evicted to stay within the budget, on both surfaces', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR', asylum: 'DEU' });
    initCanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 3 });
    const result = await runToolContract(querySeededFrom(flow), {
      sql: `SELECT year, refugees FROM ${name}`,
      register_as: 'df_EVICT_00001',
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ registered_as: 'df_EVICT_00001', evicted: [name] });
    expect(textOf(result.content)).toContain(
      `**Evicted to stay within the staging budget:** ${name}`,
    );
  });

  it('reports no evicted key when nothing was evicted', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR' });
    const result = await queryIn(flow, {
      sql: `SELECT year FROM ${name}`,
      register_as: 'df_EVICT_00002',
    });
    expect(result).not.toHaveProperty('evicted');
    expect(textOf(dataframeQueryTool.format!(result))).not.toContain('Evicted');
  });

  it('treats a blank row_limit as its default of 1000, showing the default preview of 25', async () => {
    const input = {
      sql: 'SELECT unnest(generate_series(1, 1001)) AS n',
      row_limit: ' ' as unknown as number,
    };
    expect(dataframeQueryTool.input.parse(input).row_limit).toBe(1000);
    const result = await runToolContract(dataframeQueryTool, input);
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      row_count: 1000,
      row_count_capped: true,
      shown: 25,
      cap: 25,
    });
    expect(textOf(result.content)).toContain('**1000 rows** — capped at row_limit, showing 25');
  });

  it('treats a blank register_as as unset', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS n',
      register_as: '',
    });
    expect(structuredOf(result)).not.toHaveProperty('registered_as');
  });

  it('does not read a handle inside a string literal as a dataframe reference', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT 'df_ABCDE_12345' AS handle",
    });
    expect(structuredOf(result).rows).toEqual([{ handle: 'df_ABCDE_12345' }]);
  });

  it('credits the companion series when the handle is written as a quoted identifier', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { asylum: 'JOR' });
    const result = await queryIn(flow, { sql: `SELECT year, unrwa_refugees FROM "${name}"` });
    expect(result.rows).toHaveLength(3);
    expect(result.attribution.providers).toEqual(['UNRWA']);
  });

  it('credits the companion series when the handle is written in lowercase', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { asylum: 'JOR' });
    const result = await queryIn(flow, { sql: `SELECT year FROM ${name.toLowerCase()}` });
    expect(result.rows).toHaveLength(3);
    expect(result.attribution.providers).toEqual(['UNRWA']);
  });

  it('fails a lowercase handle that is not staged as missing_table, naming the canonical handle', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM df_nope0_nope0',
    });
    expect(errorOf(result).data).toMatchObject({
      reason: 'missing_table',
      tableName: 'df_NOPE0_NOPE0',
    });
  });

  it('does not read a handle inside an SQL comment as a dataframe reference', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS n -- joined df_GONE0_GONE0 earlier\n/* and df_GONE1_GONE1 */',
    });
    expect(structuredOf(result).rows).toEqual([{ n: 1 }]);
  });
});

describe('declared errors, by reason', () => {
  it('advertises preview and row_limit as integers with no maximum, accepting over-cap values for the clamp', () => {
    const { properties } = z.toJSONSchema(dataframeQueryTool.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(properties.preview).toMatchObject({ type: 'integer', minimum: 0 });
    expect(properties.row_limit).toMatchObject({ type: 'integer', minimum: 1, default: 1000 });
    expect(properties.preview).not.toHaveProperty('maximum');
    expect(properties.row_limit).not.toHaveProperty('maximum');
    expect(properties.preview?.description).toContain(
      'Default 25; a larger value returns at most 1500, or row_limit when lower, and says so.',
    );
    expect(properties.row_limit?.description).toContain(
      'Default 1000; a larger value materializes at most 10000 and says so.',
    );
    const parse = (input: Record<string, unknown>) =>
      dataframeQueryTool.input.safeParse({ sql: 'SELECT 1', ...input });
    expect(parse({ preview: 1_000_001, row_limit: 1_000_001 }).success).toBe(true);
    for (const input of [
      { preview: 1.5 },
      { row_limit: 1.5 },
      { preview: 'many' },
      { preview: null },
    ])
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    expect(parse({ preview: ' ' }).data?.preview).toBeUndefined();
    expect(parse({}).data?.preview).toBeUndefined();
  });

  it('advertises and enforces the caps as maximums in strict mode', () => {
    const strict = defineDataframeQueryTool({ clamp: false, rowLimitCap: 10_000 });
    const { properties } = z.toJSONSchema(strict.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(properties.preview).toMatchObject({ type: 'integer', maximum: 1_500 });
    expect(properties.row_limit).toMatchObject({ type: 'integer', maximum: 10_000, default: 1000 });
    expect(properties.preview?.description).toContain('0–1500 (default 25)');
    expect(properties.row_limit?.description).toContain('1–10000 (default 1000)');
    expect(properties.row_limit?.description).not.toContain('says so');
    expect(strict.input.safeParse({ sql: 'SELECT 1', preview: 1_501 }).success).toBe(false);
    expect(strict.input.safeParse({ sql: 'SELECT 1', row_limit: 10_001 }).success).toBe(false);
    expect(strict.description).toBe(dataframeQueryTool.description);
  });
  it.each([
    ['missing_table', 'SELECT * FROM df_NOPE0_NOPE0', JsonRpcErrorCode.NotFound],
    ['invalid_sql', 'SELECT no_such_column', JsonRpcErrorCode.ValidationError],
    ['sql_execution_error', "SELECT CAST('abc' AS INTEGER) AS n", JsonRpcErrorCode.ValidationError],
    ['non_select_statement', 'CREATE TABLE t AS SELECT 1', JsonRpcErrorCode.ValidationError],
    ['multi_statement', 'SELECT 1; SELECT 2', JsonRpcErrorCode.ValidationError],
    ['denied_function', "SELECT * FROM read_csv('/etc/passwd')", JsonRpcErrorCode.ValidationError],
    ['plan_operator_not_allowed', 'SELECT * FROM range(3)', JsonRpcErrorCode.ValidationError],
    ['system_catalog_access', 'SELECT * FROM duckdb_tables()', JsonRpcErrorCode.ValidationError],
  ])('fails %s with the tool’s recovery on both surfaces', async (reason, sql, code) => {
    const result = await runToolContract(dataframeQueryTool, { sql });
    const error = errorOf(result);
    expect(error.code).toBe(code);
    expect(error.data).toMatchObject({ reason, recovery: { hint: recoveryFor(reason) } });
    const text = unescapeMarkdown(textOf(result.content));
    expect(text).toContain(`reason ${reason}`);
    expect(text).toContain(`Recovery: ${recoveryFor(reason)}`);
  });

  it('fails register_as_clash when the name is already staged', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR' });
    await expect(
      queryIn(flow, { sql: `SELECT year FROM ${name}`, register_as: name }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'register_as_clash', recovery: { hint: recoveryFor('register_as_clash') } },
    });
  });

  it('fails register_as_too_large on both surfaces when the result alone exceeds the staging budget', async () => {
    initCanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 6)) AS n',
      register_as: 'df_LARGE_00001',
    });
    const error = errorOf(result);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'register_as_too_large',
        recovery: { hint: recoveryFor('register_as_too_large') },
      },
    });
    expect(recoveryFor('register_as_too_large')).toEqual(expect.any(String));
    const text = textOf(result.content);
    expect(text).toContain('reason register_as_too_large');
    expect(text).toContain(String(recoveryFor('register_as_too_large')));
  });

  it('tells no caller to list dataframes, since listing can be off', () => {
    for (const entry of [
      ...(dataframeQueryTool.errors ?? []),
      ...(dataframeDescribeTool.errors ?? []),
    ]) {
      expect(entry.recovery, entry.reason).not.toMatch(/\blist/i);
    }
    expect(recoveryFor('missing_table')).toMatch(/evicted/);
  });

  it('fails canvas_unavailable, not retryable, when the deployment has no canvas', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1' });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        retryable: false,
        recovery: { hint: recoveryFor('canvas_unavailable') },
      },
    });
  });

  it('accepts a schema-valid preview above row_limit instead of failing with an undeclared reason', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM (VALUES (1), (2), (3)) t(n)',
      preview: 5000,
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      row_count: 3,
      rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
    });
    expect(structured).not.toHaveProperty('truncated');
  });

  it('clamps a preview above row_limit to row_limit, reporting row_limit as the cap that bound', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM (VALUES (1), (2), (3)) t(n)',
      row_limit: 2,
      preview: 5,
    });
    expect(structuredOf(result)).toMatchObject({
      row_count: 2,
      row_count_capped: true,
      rows: [{ n: 1 }, { n: 2 }],
      truncated: true,
      shown: 2,
      cap: 2,
      notice:
        'Requested preview 5; effective preview 2. Showing 2 rows. More than row_limit (2) matched, so row_count is the cap, not the full size. Use register_as to keep the whole result, or raise row_limit (max 10000).',
    });
  });

  it.each([
    ['an empty statement', { sql: '' }],
    ['a malformed register_as', { sql: 'SELECT 1', register_as: 'df_lower_12345' }],
    ['row_limit 0', { sql: 'SELECT 1', row_limit: 0 }],
    ['a fractional row_limit', { sql: 'SELECT 1', row_limit: 1.5 }],
    ['a negative preview', { sql: 'SELECT 1', preview: -1 }],
  ])('rejects %s as invalid params', async (_label, input) => {
    expect(errorOf(await runToolContract(dataframeQueryTool, input)).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it('accepts sql of exactly 20,000 characters and rejects 20,001, naming the cap on both surfaces', async () => {
    const paddedTo = (length: number) => 'SELECT 1 AS n'.padEnd(length, ' ');
    const atCap = await runToolContract(dataframeQueryTool, { sql: paddedTo(20_000) });
    expect(structuredOf(atCap).rows).toEqual([{ n: 1 }]);

    const over = await runToolContract(dataframeQueryTool, { sql: paddedTo(20_001) });
    const error = errorOf(over);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain('20,000 characters');
    expect(textOf(over.content)).toContain('20,000 characters');
  });
});

describe('format', () => {
  it('preserves pipes, line breaks, nulls and nested values as fenced JSON', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: `SELECT 'a|b' || chr(10) || 'c' AS "col|x", NULL AS empty, {'k': 1} AS nested`,
    });
    const text = textOf(result.content);
    const encoded = text.split('```json\n')[1]?.split('\n```')[0];
    expect(JSON.parse(encoded ?? '')).toEqual({
      columns: ['col|x', 'empty', 'nested'],
      rows: structuredOf(result).rows,
    });
    expect(structuredOf(result).rows).toEqual([
      { 'col|x': 'a|b\nc', empty: null, nested: { k: 1 } },
    ]);
  });

  it.each([
    [
      "SELECT repeat('😀|' || chr(10) || chr(9) || chr(92) || chr(34),10000) AS value",
      'value',
      '😀|\n\t\\"'.repeat(10000),
    ],
    [
      "SELECT {'level':{'nested':[repeat('😀',10000),NULL,'']}} AS nested",
      'nested',
      { level: { nested: ['😀'.repeat(10000), null, ''] } },
    ],
  ])('returns the exact value from %s on both surfaces', async (sql, column, value) => {
    const result = await runToolContract(dataframeQueryTool, { sql: String(sql) });
    const expected = { columns: [column], rows: [{ [String(column)]: value }] };
    expect(structuredOf(result)).toMatchObject({ ...expected, row_count: 1 });
    const encoded = textOf(result.content).split('```json\n')[1]?.split('\n```')[0];
    expect(JSON.parse(encoded ?? '')).toEqual(expected);
  });

  it('returns oversized column labels whole at preview 0, on both surfaces', async () => {
    const label = 'h'.repeat(8000);
    const result = await runToolContract(dataframeQueryTool, {
      sql: `WITH t AS (SELECT 1 AS "${label}") SELECT a.*,b.*,c.*,d.*,e.* FROM t a,t b,t c,t d,t e`,
      preview: 0,
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ rows: [], row_count: 1 });
    expect((structured.columns as string[])[0]).toBe(label);
    expect(structured.columns).toHaveLength(5);
    expect(textOf(result.content)).toContain(
      `Columns: ${(structured.columns as string[]).join(', ')}`,
    );
  });
});
