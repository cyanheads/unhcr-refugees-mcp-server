/**
 * @fileoverview Tests for `CanvasBridge` against a real in-memory DuckDB
 * canvas: staging with an explicit schema, the shared per-tenant canvas,
 * provenance metadata and its lazy expiry sweep, the SQL gate with this
 * server's recovery hints, `register_as`, drop, and the DuckDB load-failure
 * latch (a stub canvas whose `acquire` fails with `ConfigurationError`).
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  CanvasBridge,
  DATAFRAME_NAME,
  type DataframeMeta,
  dataframeGuidance,
  getCanvasBridge,
  initCanvasBridge,
  type RegisterOptions,
  referencedDataframes,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { createFailingCanvas, createTestCanvas, shutdownCanvas } from '../../helpers/services.js';

let canvas: DataCanvas;

beforeAll(() => {
  canvas = createTestCanvas();
});

afterAll(async () => {
  await shutdownCanvas(canvas);
});

/** A context carrying the query tool's contract, so rewrapped errors carry its hints. */
const queryContext = (signal?: AbortSignal) =>
  createMockContext({ errors: dataframeQueryTool.errors, ...(signal && { signal }) });

const stagedRows = (): RegisterOptions => ({
  sourceTool: 'unhcr_get_population',
  queryParams: { origin: 'SYR', limit: 1 },
  complete: true,
  providers: ['IDMC'],
  rows: [
    { year: 2024, origin_iso3: 'SYR', refugees: 5952174, oip: null },
    { year: 2025, origin_iso3: 'SYR', refugees: 4865764, oip: null },
  ],
  schema: [
    { name: 'year', type: 'INTEGER', nullable: true },
    { name: 'origin_iso3', type: 'VARCHAR', nullable: true },
    { name: 'refugees', type: 'INTEGER', nullable: true },
    { name: 'oip', type: 'INTEGER', nullable: true },
  ],
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('pure helpers', () => {
  it('finds dataframe handles in SQL, de-duplicated, ignoring those inside string literals', () => {
    expect(
      referencedDataframes(
        "SELECT * FROM df_ABCDE_12345 a JOIN df_ZZZZZ_00000 b USING (year) WHERE a.x = 'df_QQQQQ_QQQQQ' OR df_ABCDE_12345.y = 'it''s'",
      ),
    ).toEqual(['df_ABCDE_12345', 'df_ZZZZZ_00000']);
    expect(referencedDataframes('SELECT 1')).toEqual([]);
  });

  it('reads quoted identifiers and any letter case as references, in canonical form', () => {
    expect(
      referencedDataframes(
        'SELECT * FROM "df_ABCDE_12345" a JOIN df_zzzzz_00000 b USING (year) JOIN DF_AbCdE_12345 c USING (year)',
      ),
    ).toEqual(['df_ABCDE_12345', 'df_ZZZZZ_00000']);
  });

  it('skips handles inside line and block comments, but not a string that holds comment markers', () => {
    expect(
      referencedDataframes(
        "SELECT '--' AS dash, x FROM df_ABCDE_12345 -- df_QQQQQ_QQQQQ\n/* df_RRRRR_RRRRR\n */ JOIN df_ZZZZZ_00000 USING (year)",
      ),
    ).toEqual(['df_ABCDE_12345', 'df_ZZZZZ_00000']);
  });

  it('matches only whole df_XXXXX_XXXXX names', () => {
    expect(DATAFRAME_NAME.test('df_ABCDE_12345')).toBe(true);
    expect(DATAFRAME_NAME.test('df_abcde_12345')).toBe(false);
    expect(DATAFRAME_NAME.test('df_ABCDE_123456')).toBe(false);
    expect(referencedDataframes('SELECT * FROM xdf_ABCDE_12345')).toEqual([]);
  });

  it('points at describe then query in the staging guidance', () => {
    expect(
      dataframeGuidance({
        name: 'df_ABCDE_12345',
        row_count: 42,
        expires_at: '2026-09-27T00:00:00.000Z',
      }),
    ).toBe(
      'Full set staged as df_ABCDE_12345 (42 rows). Use unhcr_dataframe_describe to inspect its columns, then unhcr_dataframe_query to analyze it with SQL.',
    );
  });

  it('wires no bridge when the framework built no canvas', () => {
    expect(initCanvasBridge(undefined)).toBeUndefined();
    expect(getCanvasBridge()).toBeUndefined();
    const bridge = initCanvasBridge(canvas, { ttlMs: 1000 });
    expect(getCanvasBridge()).toBe(bridge);
    expect(bridge?.available).toBe(true);
  });
});

describe('register and describe', () => {
  it('stages rows under a minted handle with the explicit column types, and records provenance', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const ctx = queryContext();
    const staged = await bridge.register(ctx, stagedRows());

    expect(staged?.name).toMatch(DATAFRAME_NAME);
    expect(staged?.row_count).toBe(2);
    const [meta] = await bridge.describe(ctx);
    expect(meta).toMatchObject({
      tableName: staged?.name,
      sourceTool: 'unhcr_get_population',
      queryParams: { origin: 'SYR', limit: 1 },
      rowCount: 2,
      complete: true,
      providers: ['IDMC'],
      expiresAt: staged?.expires_at,
    });
    expect(Date.parse(meta?.expiresAt ?? '') - Date.parse(meta?.createdAt ?? '')).toBe(60_000);

    // An all-null column keeps its declared INTEGER type instead of a sniffed one.
    const { result } = await bridge.query(
      ctx,
      `SELECT typeof(oip) AS t, typeof(refugees) AS r FROM ${staged?.name} LIMIT 1`,
      { rowLimit: 10 },
    );
    expect(result.rows).toEqual([{ t: 'INTEGER', r: 'INTEGER' }]);
  });

  it('stages nothing for an empty result', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const ctx = queryContext();
    await expect(bridge.register(ctx, { ...stagedRows(), rows: [] })).resolves.toBeUndefined();
    await expect(bridge.describe(ctx)).resolves.toEqual([]);
  });

  it('keeps every dataframe of a tenant on one shared canvas, listed newest first', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const ctx = queryContext();
    const first = await bridge.register(ctx, stagedRows());
    await sleep(5);
    const second = await bridge.register(ctx, {
      ...stagedRows(),
      sourceTool: 'unhcr_get_solutions',
    });

    const listed = await bridge.describe(ctx);
    expect(listed.map((meta) => meta.tableName)).toEqual([second?.name, first?.name]);
    const { result } = await bridge.query(
      ctx,
      `SELECT count(*) AS n FROM ${first?.name} a JOIN ${second?.name} b USING (year)`,
      { rowLimit: 10 },
    );
    expect(Number(result.rows[0]?.n)).toBe(2);
    await expect(bridge.describe(ctx, second?.name)).resolves.toEqual([
      expect.objectContaining({ sourceTool: 'unhcr_get_solutions' }),
    ]);
    await expect(bridge.describe(ctx, 'df_NOPE0_NOPE0')).resolves.toEqual([]);
  });

  it('acquires a fresh canvas when the stored canvas id is no longer live', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const ctx = queryContext();
    await ctx.state.set('canvas-id', 'AAAAAAAAAA');
    const staged = await bridge.register(ctx, stagedRows());
    expect(staged).toBeDefined();
    expect(await ctx.state.get('canvas-id')).not.toBe('AAAAAAAAAA');
  });

  it('sweeps expired dataframes: metadata deleted and the table dropped', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 50 });
    const ctx = queryContext();
    const staged = await bridge.register(ctx, stagedRows());
    await sleep(80);
    await expect(bridge.describe(ctx)).resolves.toEqual([]);
    await expect(ctx.state.get(`df-meta/${staged?.name}`)).resolves.toBeNull();
    await expect(
      bridge.query(ctx, `SELECT * FROM ${staged?.name}`, { rowLimit: 10 }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'missing_table' } });
  });
});

describe('query', () => {
  const stageOne = async (ctx = queryContext(), options: Partial<RegisterOptions> = {}) => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const staged = await bridge.register(ctx, { ...stagedRows(), ...options });
    if (!staged) throw new Error('staging failed');
    return { bridge, ctx, name: staged.name };
  };

  it('runs a SELECT and credits the providers of every referenced dataframe', async () => {
    const { bridge, ctx, name } = await stageOne();
    const other = await bridge.register(ctx, { ...stagedRows(), providers: ['UNRWA'] });
    const { result, providers, meta } = await bridge.query(
      ctx,
      `SELECT a.year FROM ${name} a JOIN ${other?.name} b USING (year) ORDER BY 1`,
      { rowLimit: 10 },
    );
    expect(result.rows).toEqual([{ year: 2024 }, { year: 2025 }]);
    expect(providers).toEqual(['IDMC', 'UNRWA']);
    expect(meta).toBeUndefined();
  });

  it('fails a reference to an unstaged dataframe as missing_table before touching the canvas', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const ctx = queryContext();
    const error = await bridge
      .query(ctx, 'SELECT * FROM df_NOPE0_NOPE0', { rowLimit: 10 })
      .catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'missing_table',
        tableName: 'df_NOPE0_NOPE0',
        recovery: {
          hint: 'Use unhcr_dataframe_describe to list the staged dataframes, or re-run the unhcr_get_* call that produced it.',
        },
      },
    });
    await expect(ctx.state.get('canvas-id')).resolves.toBeNull();
  });

  it('reports a table lost with its canvas as missing_table even while its metadata survives', async () => {
    const { bridge, ctx, name } = await stageOne();
    const canvasId = await ctx.state.get<string>('canvas-id');
    await canvas.drop(canvasId ?? '', ctx);
    await expect(
      bridge.query(ctx, `SELECT * FROM ${name}`, { rowLimit: 10 }),
    ).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
  });

  it.each([
    ['invalid_sql', 'SELECT nope FROM {df}'],
    ['sql_execution_error', "SELECT CAST('abc' AS INTEGER) FROM {df}"],
    ['non_select_statement', 'DELETE FROM {df}'],
    ['non_select_statement', 'SELEC year FROM {df}'],
    ['multi_statement', 'SELECT 1 FROM {df}; SELECT 2'],
    ['denied_function', "SELECT * FROM read_csv('/etc/passwd')"],
    ['plan_operator_not_allowed', 'SELECT * FROM range(3)'],
    ['system_catalog_access', 'SELECT * FROM information_schema.tables'],
  ])(
    'rebuilds the gate rejection %s with the calling tool’s recovery hint (%s)',
    async (reason, template) => {
      const { bridge, ctx, name } = await stageOne();
      const error = await bridge
        .query(ctx, template.replaceAll('{df}', name), { rowLimit: 10 })
        .catch((e) => e);
      const contract = dataframeQueryTool.errors?.find((entry) => entry.reason === reason);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason, recovery: { hint: contract?.recovery } },
      });
    },
  );

  it('fails a register_as clash with the tool’s hint', async () => {
    const { bridge, ctx, name } = await stageOne();
    await expect(
      bridge.query(ctx, `SELECT year FROM ${name}`, { rowLimit: 10, registerAs: name }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'register_as_clash',
        recovery: {
          hint: 'Choose a different df_XXXXX_XXXXX name for register_as, or omit register_as.',
        },
      },
    });
  });

  it('registers a query result as a new dataframe inheriting completeness and providers', async () => {
    const { bridge, ctx, name } = await stageOne(queryContext(), { complete: false });
    const sql = `SELECT year, refugees FROM ${name} WHERE year = 2025`;
    const { result, meta, providers } = await bridge.query(ctx, sql, {
      rowLimit: 10,
      registerAs: 'df_DERIV_00001',
    });
    expect(result).toMatchObject({ rowCount: 1, tableName: 'df_DERIV_00001' });
    expect(providers).toEqual(['IDMC']);
    expect(meta).toMatchObject({
      tableName: 'df_DERIV_00001',
      sourceTool: 'unhcr_dataframe_query',
      queryParams: { sql },
      rowCount: 1,
      complete: false,
      providers: ['IDMC'],
    });
    expect(meta?.columnSchema.map((column) => column.name)).toEqual(['year', 'refugees']);
    const listed = await bridge.describe(ctx, 'df_DERIV_00001');
    expect(listed).toHaveLength(1);
  });

  it('honors preview and reports a capped result', async () => {
    const { bridge, ctx, name } = await stageOne();
    const capped = await bridge.query(ctx, `SELECT * FROM ${name}`, { rowLimit: 1 });
    expect(capped.result).toMatchObject({ rowCount: 1, truncated: true });
    const previewed = await bridge.query(ctx, `SELECT * FROM ${name}`, {
      rowLimit: 10,
      preview: 1,
    });
    expect(previewed.result.rows).toHaveLength(1);
    expect(previewed.result.rowCount).toBe(2);
  });
});

describe('drop', () => {
  it('drops the table and its metadata, and reports false once nothing matches', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const ctx = queryContext();
    const staged = await bridge.register(ctx, stagedRows());
    const name = staged?.name ?? '';
    await expect(bridge.drop(ctx, name)).resolves.toBe(true);
    await expect(bridge.describe(ctx)).resolves.toEqual([]);
    await expect(bridge.drop(ctx, name)).resolves.toBe(false);
  });
});

describe('failure handling', () => {
  it('latches a DuckDB load failure: staging returns nothing and no later call retries the load', async () => {
    const { canvas: failing, acquire } = createFailingCanvas();
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const ctx = queryContext();

    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    expect(bridge.available).toBe(false);
    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(1);

    const error = await bridge.query(ctx, 'SELECT 1', { rowLimit: 10 }).catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable', retryable: false },
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    const warnings = (ctx.log as MockContextLogger).calls.filter(
      (call) => call.level === 'warning',
    );
    expect(warnings.map((call) => call.msg)).toContain(
      'DataCanvas unavailable: the DuckDB binding could not load',
    );
  });

  it('keeps the bridge available after a staging failure that is not a load failure', async () => {
    const { canvas: failing, acquire } = createFailingCanvas(new Error('disk full'));
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const ctx = queryContext();
    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    expect(bridge.available).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
    const warnings = (ctx.log as MockContextLogger).calls.filter(
      (call) => call.level === 'warning',
    );
    expect(warnings[0]).toMatchObject({
      msg: 'Dataframe staging failed; the inline rows stand',
      data: { error: 'disk full', sourceTool: 'unhcr_get_population' },
    });
  });

  it('rethrows when the request was cancelled instead of swallowing the failure', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const controller = new AbortController();
    const ctx = queryContext(controller.signal);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(bridge.register(ctx, stagedRows())).rejects.toBeDefined();
  });

  it('sweeps expired metadata without touching the canvas once latched off', async () => {
    const { canvas: failing, acquire } = createFailingCanvas();
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const ctx = queryContext();
    await bridge.register(ctx, stagedRows());
    const expired: DataframeMeta = {
      tableName: 'df_OLD00_OLD00',
      sourceTool: 'unhcr_get_population',
      queryParams: {},
      createdAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-02T00:00:00.000Z',
      rowCount: 1,
      complete: true,
      providers: [],
      columnSchema: [],
    };
    await ctx.state.set('df-meta/df_OLD00_OLD00', expired);
    await expect(bridge.describe(ctx)).resolves.toEqual([]);
    await expect(ctx.state.get('df-meta/df_OLD00_OLD00')).resolves.toBeNull();
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
