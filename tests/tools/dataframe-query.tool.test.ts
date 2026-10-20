/**
 * @fileoverview Tests for unhcr_dataframe_query over a real in-memory DuckDB
 * canvas: results on both surfaces, the enrichment contract on empty,
 * under-cap, capped, and previewed pages, attribution carried from the staged
 * dataframes, register_as and the staging budget's evictions, every declared
 * error reason, and cell escaping.
 * @module tests/tools/dataframe-query.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { TERMS_URL } from '@/services/unhcr/codes.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { carryDataframeState, flowContext, stagePopulation } from '../helpers/dataframes.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
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

  it('bounds a single large cell without losing its retrieval path', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT repeat('x',600000) AS long_cell",
      preview: 1,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
    expect(structuredOf(result)).toHaveProperty('result_chunks');
  });

  it('accepts and discloses preview preferences above the display ceiling', async () => {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS n',
      preview: 10_001,
    });
    expect(structuredOf(result).rows).toEqual([{ n: 1 }]);
    expect(structuredOf(result).notice).toContain(
      'Requested preview 10001; effective preview 1000.',
    );
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
      notice: 'Showing 1 of 3 rows. Use register_as to keep the whole result, or raise preview.',
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

  it('treats a blank row_limit as its default of 1000', async () => {
    const input = {
      sql: 'SELECT unnest(generate_series(1, 1001)) AS n',
      row_limit: ' ' as unknown as number,
    };
    expect(dataframeQueryTool.input.parse(input).row_limit).toBe(1000);
    const result = await runToolContract(dataframeQueryTool, input);
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ row_count: 1000, row_count_capped: true, cap: 1000 });
    expect(textOf(result.content)).toContain('**1000 rows** — capped at row_limit');
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
  it('advertises and enforces the finite preview preference bound, preserving zero, blanks and defaults', () => {
    for (const preview of [0, 10_000, 10_001, 1_000_000])
      expect(dataframeQueryTool.input.parse({ sql: 'SELECT 1', preview }).preview).toBe(preview);
    for (const preview of [-1, 0.5, 1_000_001, 'many', null])
      expect(dataframeQueryTool.input.safeParse({ sql: 'SELECT 1', preview }).success).toBe(false);
    expect(
      dataframeQueryTool.input.parse({ sql: 'SELECT 1', preview: ' ' }).preview,
    ).toBeUndefined();
    expect(dataframeQueryTool.input.parse({ sql: 'SELECT 1' }).preview).toBeUndefined();
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
    const text = textOf(result.content);
    expect(text).toContain(`reason ${reason}`);
    expect(text).toContain(String(recoveryFor(reason)));
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
    ['row_limit above 10000', { sql: 'SELECT 1', row_limit: 10_001 }],
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
});

describe('lossless bounded snapshots', () => {
  it.each([false, true])(
    'composes source, clamp, byte and saved-table disclosures (register_as %s)',
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
        sql: `SELECT repeat('x',60000) AS value FROM ${name}`,
        row_limit: 1,
        preview: 10_001,
        ...(saved && { register_as: 'df_COMBO_00001' }),
      });
      const structured = structuredOf(result);
      expect(structured).toMatchObject({
        complete: false,
        incomplete_sources: [name],
        row_count_capped: !saved,
        rows: [],
        truncated: true,
      });
      for (const fragment of [
        name,
        'Requested preview 10001; effective preview 1.',
        '65536 UTF-8 bytes',
        'Base64-decode each chunk separately',
      ]) {
        expect(structured.notice).toContain(fragment);
        expect(textOf(result.content)).toContain(fragment);
      }
      if (saved) {
        expect(structured.notice).toContain('the full result is saved as df_COMBO_00001');
        expect(textOf(result.content)).not.toContain('Use register_as');
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
    },
  );
  const contractIn = (flow: ReturnType<typeof flowContext>, input: Input) => {
    const seeded: typeof dataframeQueryTool = {
      ...dataframeQueryTool,
      handler: async (parsed, ctx) => {
        await carryDataframeState(flow, ctx);
        const output = await dataframeQueryTool.handler(parsed, ctx);
        await carryDataframeState(ctx, flow);
        return output;
      },
    };
    return runToolContract(seeded, input);
  };

  const bounded = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    expect(result.isError).not.toBe(true);
    // The SDK's object-root output schema keeps these surfaces on both eras;
    // modern adds resultType, while legacy leaves the complete object as-is.
    for (const shape of [result, { ...result, resultType: 'complete' }]) {
      expect(Buffer.byteLength(JSON.stringify(shape))).toBeLessThanOrEqual(65_536);
      expect(
        Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 123456789, result: shape })),
      ).toBeLessThanOrEqual(65_536);
    }
  };

  const recover = async (flow: ReturnType<typeof flowContext>, metadata: unknown) => {
    const chunks = metadata as { name: string; chunk_count: number };
    const pieces: Buffer[] = [];
    for (let index = 0; index < chunks.chunk_count; index++) {
      const page = await contractIn(flow, {
        sql: `SELECT chunk_index,chunk FROM ${chunks.name} WHERE chunk_index=${index}`,
      });
      bounded(page);
      const rows = structuredOf(page).rows as { chunk_index: number; chunk: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.chunk_index).toBe(index);
      const encoded = textOf(page.content).split('```json\n')[1]?.split('\n```')[0];
      expect(JSON.parse(encoded ?? '').rows).toEqual(rows);
      const bytes = Buffer.from(rows[0]?.chunk ?? '', 'base64');
      expect(bytes.length).toBeLessThanOrEqual(6144);
      pieces.push(bytes);
    }
    return JSON.parse(Buffer.concat(pieces).toString('utf8')) as Record<string, unknown>;
  };

  it.each([
    ["SELECT repeat('x',600000) AS long_cell", 'long_cell', 'x'.repeat(600000)],
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
  ])('reassembles exact values and column labels from %s', async (sql, column, value) => {
    const flow = flowContext();
    const result = await contractIn(flow, { sql: String(sql), preview: 1 });
    bounded(result);
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      rows: [],
      row_count: 1,
      row_count_capped: false,
      complete: true,
      truncated: true,
    });
    expect(structured.notice).toContain('65536 UTF-8 bytes');
    expect(textOf(result.content)).toContain(String(structured.notice));
    const recovered = await recover(flow, structured.result_chunks);
    expect(recovered).toMatchObject({
      columns: [column],
      rows: [{ [String(column)]: value }],
      row_count: 1,
      complete: true,
    });
  });

  it('withholds oversized column metadata at preview zero and retains all materialized rows', async () => {
    const flow = flowContext();
    const label = 'h'.repeat(8000);
    const sql = `WITH t AS (SELECT 1 AS "${label}") SELECT a.*,b.*,c.*,d.*,e.* FROM t a,t b,t c,t d,t e`;
    const result = await contractIn(flow, { sql, preview: 0 });
    bounded(result);
    expect(structuredOf(result)).toMatchObject({ rows: [], columns: [], metadata_withheld: true });
    const recovered = await recover(flow, structuredOf(result).result_chunks);
    expect((recovered.columns as string[])[0]).toBe(label);
    expect(recovered.rows).toHaveLength(1);
    expect(Object.keys((recovered.rows as object[])[0] ?? {})).toHaveLength(5);
    expect(Object.values((recovered.rows as object[])[0] ?? {})).toEqual([1, 1, 1, 1, 1]);
  });

  it('keeps saved-table guidance and protects the saved table while staging chunks', async () => {
    initCanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 20 });
    const flow = flowContext();
    const result = await contractIn(flow, {
      sql: "SELECT repeat('x',60000) AS value",
      register_as: 'df_SAVED_00011',
      preview: 1_000_000,
    });
    bounded(result);
    const structured = structuredOf(result);
    expect(structured.notice).toContain('Requested preview 1000000; effective preview 1000.');
    expect(structured.notice).toContain('the full result is saved as df_SAVED_00011');
    expect(textOf(result.content)).not.toContain('Use register_as');
    expect(await getCanvasBridge()!.describe(flow, 'df_SAVED_00011')).toHaveLength(1);
    const recovered = await recover(flow, structured.result_chunks);
    expect(recovered.rows).toEqual([{ value: 'x'.repeat(60000) }]);
  });

  it('re-slices chunk pages within budget while pointing to the same snapshot', async () => {
    const flow = flowContext();
    const first = await contractIn(flow, { sql: "SELECT repeat('x',600000) AS value" });
    const chunks = structuredOf(first).result_chunks as { name: string; chunk_count: number };
    const before = (await getCanvasBridge()!.describe(flow)).map((meta) => meta.tableName);
    for (const offset of [0, 4]) {
      const page = await contractIn(flow, {
        sql: `SELECT chunk_index,chunk FROM ${chunks.name} ORDER BY chunk_index LIMIT 10 OFFSET ${offset}`,
        preview: 10,
      });
      bounded(page);
      expect(structuredOf(page).result_chunks).toMatchObject({ name: chunks.name });
      const rows = structuredOf(page).rows as { chunk_index: number }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.chunk_index).toBe(offset);
      expect(rows.length).toBeLessThan(10);
    }
    expect((await getCanvasBridge()!.describe(flow)).map((meta) => meta.tableName)).toEqual(before);
    const pastEnd = await contractIn(flow, {
      sql: `SELECT chunk_index,chunk FROM ${chunks.name} WHERE chunk_index=${chunks.chunk_count}`,
    });
    bounded(pastEnd);
    expect(structuredOf(pastEnd).rows).toEqual([]);
  });

  it('fails explicitly when the chunks and saved table cannot both fit', async () => {
    initCanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 2 });
    const flow = flowContext();
    const result = await contractIn(flow, {
      sql: "SELECT repeat('x',60000) AS value",
      register_as: 'df_SAVED_00012',
    });
    expect(errorOf(result).data).toMatchObject({
      reason: 'result_storage_unavailable',
      retryable: false,
      recovery: { hint: recoveryFor('result_storage_unavailable') },
    });
    expect(textOf(result.content)).toContain(String(recoveryFor('result_storage_unavailable')));
  });

  it('expires chunk metadata and returns the normal missing_table recovery', async () => {
    const flow = flowContext();
    const result = await contractIn(flow, { sql: "SELECT repeat('x',60000) AS value" });
    const chunks = structuredOf(result).result_chunks as { name: string };
    const [meta] = await getCanvasBridge()!.describe(flow, chunks.name);
    await flow.state.set(`df-meta/${chunks.name}`, {
      ...meta,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await expect(queryIn(flow, { sql: `SELECT * FROM ${chunks.name}` })).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
    const expired = await contractIn(flow, {
      sql: `SELECT chunk_index,chunk FROM ${chunks.name} WHERE chunk_index=0`,
    });
    expect(errorOf(expired).data).toMatchObject({
      reason: 'missing_table',
      recovery: { hint: recoveryFor('missing_table') },
    });
    expect(await flow.state.get(`df-meta/${chunks.name}`)).toBeNull();
  });
});
