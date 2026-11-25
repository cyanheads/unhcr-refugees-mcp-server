/**
 * @fileoverview Tests for `CanvasBridge` against a real in-memory DuckDB
 * canvas: staging with an explicit schema, the one shared canvas per tenant
 * under concurrent first calls and after it dies, provenance metadata and its
 * lazy expiry sweep, metadata of a canvas that is not the live one, the SQL
 * gate with this server's recovery hints, `register_as`, the staging budget and
 * the per-tenant turn its recordings take, drop, the TTL and cancellation
 * signal the engine gets, and the DuckDB load-failure latch (a canvas whose
 * mint fails with `ConfigurationError`).
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  CanvasBridge,
  DATAFRAME_NAME,
  type DataframeMeta,
  DEFAULT_STAGED_ROW_BUDGET,
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

/** `stagedRows()` with `count` rows. */
const rowsOf = (count: number): RegisterOptions => ({
  ...stagedRows(),
  rows: Array.from({ length: count }, (_, i) => ({
    year: 2000 + i,
    origin_iso3: 'SYR',
    refugees: i,
    oip: null,
  })),
});

/** The tenant's shared canvas on `target`, as its storage names it. */
const sharedCanvas = async (target: DataCanvas, ctx: Context) =>
  target.acquire((await ctx.state.get<string>('canvas-id')) ?? undefined, ctx);

/** Tables physically present on the tenant's shared canvas, sorted. */
const canvasTables = async (ctx: Context): Promise<string[]> =>
  (await (await sharedCanvas(canvas, ctx)).describe()).map((table) => table.name).sort();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs before each storage operation of one call, with the operation's name and key or prefix. */
type StateHook = (operation: string, key: string) => Promise<void> | void;

let tenantCount = 0;

/**
 * A tenant of its own. Each `call()` is a fresh context over the tenant's one
 * in-memory storage, as a server gives every request; a call's operations stop
 * once its own signal aborts, whatever the other calls do. `state` is the
 * storage itself, for setup and assertions.
 */
function newTenant() {
  const tenantId = `tenant-${++tenantCount}`;
  const { state } = createMockContext({ tenantId });
  const call = (options: { before?: StateHook; signal?: AbortSignal } = {}) => {
    const signal = options.signal ?? new AbortController().signal;
    const ctx = createMockContext({ tenantId, signal, errors: dataframeQueryTool.errors });
    const callState = Object.fromEntries(
      Object.entries(state).map(([operation, run]) => [
        operation,
        async (...args: unknown[]) => {
          signal.throwIfAborted();
          await options.before?.(operation, String(args[0]));
          return Reflect.apply(run, state, args);
        },
      ]),
    ) as unknown as Context['state'];
    return Object.assign(ctx, { state: callState });
  };
  return { call, state };
}

type Tenant = ReturnType<typeof newTenant>;

/** Names of the dataframes the tenant's storage holds metadata for, sorted. */
const recordedNames = async (state: Context['state']): Promise<string[]> =>
  (await state.list('df-meta/', { limit: 100 })).items.map(({ key }) => key.slice(8)).sort();

/** One event-loop turn: every pending microtask has run when it resolves. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** `promise`'s state after everything that can run without it has run. */
const settledWithin = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await turn();
  return settled;
};

/**
 * Tap the next `registerTable` on `target`: `registered` resolves once the
 * engine holds the rows, and the call itself returns only after `release()`.
 */
function holdRegistration(target: DataCanvas) {
  const provider = target.getProvider();
  const registerTable = provider.registerTable.bind(provider);
  const registered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  vi.spyOn(provider, 'registerTable').mockImplementationOnce(async (...args) => {
    const result = await registerTable(...args);
    registered.resolve();
    await gate.promise;
    return result;
  });
  return { registered: registered.promise, release: gate.resolve };
}

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

  it('follows nested literal query statements while ignoring strings and comments at every level', () => {
    const inner =
      "SELECT * FROM df_abcde_12345 WHERE 'df_FALSE_00001' = 'df_FALSE_00001' /* df_FALSE_00002 */";
    const middle = `SELECT * FROM query('${inner.replaceAll("'", "''")}')`;
    expect(
      referencedDataframes(
        `SELECT * FROM query('${middle.replaceAll("'", "''")}') -- df_FALSE_00003`,
      ),
    ).toEqual(['df_ABCDE_12345']);
    expect(
      referencedDataframes("SELECT 'query(''SELECT * FROM df_FALSE_00004'')' AS text"),
    ).toEqual([]);
  });

  it('skips handles inside line and block comments, but not a string that holds comment markers', () => {
    expect(
      referencedDataframes(
        "SELECT '--' AS dash, x FROM df_ABCDE_12345 -- df_QQQQQ_QQQQQ\n/* df_RRRRR_RRRRR\n */ JOIN df_ZZZZZ_00000 USING (year)",
      ),
    ).toEqual(['df_ABCDE_12345', 'df_ZZZZZ_00000']);
  });

  it('scans 20,000 characters of unbalanced or doubled quotes within 50 ms', () => {
    for (const unit of ["'", "'a", "x''"]) {
      const sql = unit.repeat(Math.ceil(20_000 / unit.length)).slice(0, 20_000);
      const started = performance.now();
      expect(referencedDataframes(sql)).toEqual([]);
      expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(50);
    }
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
});

describe('an expired dataframe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A tenant whose one dataframe, of three rows, reaches its expiry as no call has yet seen. */
  async function expiredDataframe() {
    vi.useFakeTimers({ toFake: ['Date'] });
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });
    const t = newTenant();
    const staged = await bridge.register(t.call(), rowsOf(3));
    vi.setSystemTime(Date.now() + 60_000);
    return { bridge, name: staged?.name ?? '', t };
  }

  it('is swept by describe: metadata deleted and the table dropped', async () => {
    const { bridge, t } = await expiredDataframe();
    await expect(bridge.describe(t.call())).resolves.toEqual([]);
    expect(await recordedNames(t.state)).toEqual([]);
    expect(await canvasTables(t.call())).toEqual([]);
  });

  it('fails a query naming it missing_table', async () => {
    const { bridge, name, t } = await expiredDataframe();
    await expect(
      bridge.query(t.call(), `SELECT * FROM ${name}`, { rowLimit: 10 }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table', tableName: name },
    });
    expect(await canvasTables(t.call())).toEqual([]);
  });

  it('does not count toward the budget of the next staging', async () => {
    const { bridge, t } = await expiredDataframe();
    const next = await bridge.register(t.call(), rowsOf(3));
    expect(next).not.toHaveProperty('evicted');
    expect(await recordedNames(t.state)).toEqual([next?.name]);
    expect(await canvasTables(t.call())).toEqual([next?.name]);
  });

  it('drops as false', async () => {
    const { bridge, name, t } = await expiredDataframe();
    await expect(bridge.drop(t.call(), name)).resolves.toBe(false);
    expect(await recordedNames(t.state)).toEqual([]);
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
          hint: 'Check the name against the dataset.name or register_as that created it; if it expired or was evicted, re-run the unhcr_get_* call that produced it.',
        },
      },
    });
    await expect(ctx.state.get('canvas-id')).resolves.toBeNull();
  });

  it('names the dataframe that is missing, not the staged one the SQL names before it', async () => {
    const { bridge, ctx, name } = await stageOne();
    await expect(
      bridge.query(ctx, `SELECT * FROM ${name} JOIN df_NOPE0_NOPE0 USING (year)`, {
        rowLimit: 10,
      }),
    ).rejects.toMatchObject({
      message:
        'Dataframe df_NOPE0_NOPE0 is not staged; it may have expired or been evicted to make room for newer dataframes.',
      data: { reason: 'missing_table', tableName: 'df_NOPE0_NOPE0' },
    });
  });

  it('names the first dataframe of the SQL when the tenant has no canvas', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    await expect(
      bridge.query(
        newTenant().call(),
        'SELECT * FROM df_NOPE0_00002 JOIN df_NOPE0_00001 USING (year)',
        { rowLimit: 10 },
      ),
    ).rejects.toMatchObject({
      message:
        'Dataframe df_NOPE0_00002 is not staged; it may have expired or been evicted to make room for newer dataframes.',
      data: { reason: 'missing_table', tableName: 'df_NOPE0_00002' },
    });
  });

  it('reports a dataframe lost with its canvas as missing_table', async () => {
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
    ['sql_execution_error', 'SELECT * FROM range(1, 10, 0)'],
    ['non_select_statement', 'PIVOT {df} ON year USING sum(refugees)'],
    ['plan_operator_not_allowed', 'SELECT * FROM {df} t, range(t.year)'],
    ['system_catalog_access', 'SELECT * FROM information_schema.tables'],
    ['system_catalog_access', 'SELECT year AS pg_class FROM {df}'],
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

  it('reports a result capped at rowLimit', async () => {
    const { bridge, ctx, name } = await stageOne();
    const capped = await bridge.query(ctx, `SELECT * FROM ${name}`, { rowLimit: 1 });
    expect(capped.result).toMatchObject({ rowCount: 1, truncated: true });
  });

  it('retains both incomplete roots across joined descendants after ancestor eviction and expiry', async () => {
    const ctx = queryContext();
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });
    const first = await bridge.register(ctx, { ...stagedRows(), complete: false });
    const second = await bridge.register(ctx, {
      ...stagedRows(),
      complete: false,
      providers: ['UNRWA'],
    });
    const roots = [first!.name, second!.name].sort();
    const child = await bridge.query(
      ctx,
      `SELECT a.year FROM "${first!.name.toLowerCase()}" a JOIN ${second!.name} b USING(year)`,
      { rowLimit: 10, registerAs: 'df_CHILD_00020' },
    );
    expect(child).toMatchObject({
      complete: false,
      incompleteSources: roots,
      providers: ['IDMC', 'UNRWA'],
    });
    expect(child.evicted).toHaveLength(1);
    for (const root of roots) {
      const [meta] = await bridge.describe(ctx, root);
      if (meta)
        await ctx.state.set(`df-meta/${root}`, { ...meta, expiresAt: '2000-01-01T00:00:00.000Z' });
    }
    const grandchild = await bridge.query(
      ctx,
      "SELECT * FROM query('SELECT * FROM df_CHILD_00020') WHERE false",
      { rowLimit: 1, registerAs: 'df_GRAND_00020' },
    );
    expect(grandchild).toMatchObject({
      complete: false,
      incompleteSources: roots,
      result: { rows: [] },
      meta: { complete: false, incompleteSources: roots },
    });
    expect((await bridge.describe(ctx)).some((meta) => roots.includes(meta.tableName))).toBe(false);
    expect(await bridge.query(ctx, 'SELECT 1 AS n', { rowLimit: 1 })).toMatchObject({
      complete: true,
      incompleteSources: [],
    });
  });
});

describe('listing', () => {
  it('is on by default and off when the deployment turns it off', () => {
    expect(new CanvasBridge(canvas, { ttlMs: 60_000 }).listingEnabled).toBe(true);
    expect(new CanvasBridge(canvas, { ttlMs: 60_000, listing: false }).listingEnabled).toBe(false);
  });
});

describe('staging budget', () => {
  const budgetBridge = () => new CanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });

  it('defaults to 1,000,000 rows per tenant', () => {
    expect(DEFAULT_STAGED_ROW_BUDGET).toBe(1_000_000);
  });

  it('evicts the oldest dataframes once a new one takes the tenant over budget, and names them', async () => {
    const bridge = budgetBridge();
    const ctx = queryContext();
    const a = await bridge.register(ctx, rowsOf(3));
    await sleep(5);
    const b = await bridge.register(ctx, rowsOf(2));
    await sleep(5);
    expect(a).not.toHaveProperty('evicted');
    expect(b).not.toHaveProperty('evicted');

    const c = await bridge.register(ctx, rowsOf(3));
    expect(c?.evicted).toEqual([a?.name]);
    expect((await bridge.describe(ctx)).map((meta) => meta.tableName)).toEqual([c?.name, b?.name]);
    expect(await canvasTables(ctx)).toEqual([b?.name, c?.name].sort());
    await expect(
      bridge.query(ctx, `SELECT * FROM ${a?.name}`, { rowLimit: 10 }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('evicted'),
      data: { reason: 'missing_table' },
    });
  });

  it('never evicts the dataframe just staged, even when it alone exceeds the budget', async () => {
    const bridge = budgetBridge();
    const ctx = queryContext();
    const b = await bridge.register(ctx, rowsOf(2));
    await sleep(5);
    const c = await bridge.register(ctx, rowsOf(3));
    await sleep(5);
    const d = await bridge.register(ctx, rowsOf(7));
    expect(d?.evicted).toEqual([b?.name, c?.name]);
    expect((await bridge.describe(ctx)).map((meta) => meta.tableName)).toEqual([d?.name]);
  });

  it('evicts after a register_as result exists, so the tables its SQL reads stay readable', async () => {
    const bridge = budgetBridge();
    const ctx = queryContext();
    const a = await bridge.register(ctx, rowsOf(2));
    await sleep(5);
    const b = await bridge.register(ctx, rowsOf(2));
    await sleep(5);
    const { result, meta, evicted } = await bridge.query(ctx, `SELECT * FROM ${a?.name}`, {
      rowLimit: 10,
      registerAs: 'df_BUDGT_00001',
    });
    expect(result.rowCount).toBe(2);
    expect(meta?.tableName).toBe('df_BUDGT_00001');
    expect(evicted).toEqual([a?.name]);
    expect(await canvasTables(ctx)).toEqual([b?.name, 'df_BUDGT_00001'].sort());
  });

  it('reports no evicted key when a register_as stays within the budget', async () => {
    const bridge = budgetBridge();
    const ctx = queryContext();
    const a = await bridge.register(ctx, rowsOf(2));
    const queried = await bridge.query(ctx, `SELECT * FROM ${a?.name}`, {
      rowLimit: 10,
      registerAs: 'df_BUDGT_00002',
    });
    expect(queried).not.toHaveProperty('evicted');
  });

  it('drops a register_as result that alone exceeds the budget, failing register_as_too_large and evicting nothing', async () => {
    const bridge = budgetBridge();
    const ctx = queryContext();
    const a = await bridge.register(ctx, rowsOf(2));
    const error = await bridge
      .query(ctx, 'SELECT unnest(generate_series(1, 6)) AS n', {
        rowLimit: 10,
        registerAs: 'df_BUDGT_00003',
      })
      .catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'register_as_too_large',
        rowCount: 6,
        rowBudget: 5,
        recovery: {
          hint: dataframeQueryTool.errors?.find((e) => e.reason === 'register_as_too_large')
            ?.recovery,
        },
      },
    });
    expect((await bridge.describe(ctx)).map((meta) => meta.tableName)).toEqual([a?.name]);
    expect(await canvasTables(ctx)).toEqual([a?.name]);
  });

  it('names no dataframe in the eviction log line, since under a shared tenant they are other callers’ handles', async () => {
    const bridge = budgetBridge();
    const ctx = queryContext();
    const a = await bridge.register(ctx, rowsOf(3));
    await sleep(5);
    await bridge.register(ctx, rowsOf(3));
    const calls = (ctx.log as MockContextLogger).calls;
    const eviction = calls.find((call) => call.msg.includes('evicted'));
    expect(eviction).toMatchObject({ level: 'info', data: { evictedCount: 1 } });
    expect(JSON.stringify(eviction)).not.toContain(String(a?.name));
  });

  it('leaves no metadata of a dropped table when the call is cancelled while it evicts', async () => {
    const bridge = budgetBridge();
    const t = newTenant();
    await bridge.register(t.call(), rowsOf(3));
    await bridge.register(t.call(), rowsOf(2));
    const controller = new AbortController();
    const provider = canvas.getProvider();
    const drop = provider.drop.bind(provider);
    const dropped = vi.spyOn(provider, 'drop').mockImplementationOnce(async (...args) => {
      const result = await drop(...args);
      controller.abort(new DOMException('cancelled', 'AbortError'));
      return result;
    });
    await bridge.register(t.call({ signal: controller.signal }), rowsOf(5)).catch(() => {});
    expect(dropped).toHaveBeenCalled();
    dropped.mockRestore();
    expect(await recordedNames(t.state)).toEqual(await canvasTables(t.call()));
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

  it.each([
    [
      'a table whose metadata is gone',
      (t: Tenant, name: string) => t.state.delete(`df-meta/${name}`),
    ],
    [
      'metadata whose table is gone',
      async (t: Tenant, name: string) => (await sharedCanvas(canvas, t.call())).drop(name),
    ],
  ])('answers true for %s, leaving neither', async (_, lose) => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    const name = (await bridge.register(t.call(), stagedRows()))?.name ?? '';
    await lose(t, name);
    expect([...(await recordedNames(t.state)), ...(await canvasTables(t.call()))]).toEqual([name]);

    await expect(bridge.drop(t.call(), name)).resolves.toBe(true);
    expect(await recordedNames(t.state)).toEqual([]);
    expect(await canvasTables(t.call())).toEqual([]);
  });
});

describe('what reaches the engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['a data tool’s', (bridge: CanvasBridge, ctx: Context) => bridge.register(ctx, stagedRows())],
    [
      'a register_as',
      (bridge: CanvasBridge, ctx: Context) =>
        bridge.query(ctx, 'SELECT 1 AS n', { rowLimit: 10, registerAs: 'df_TABLE_00001' }),
    ],
  ])('carries the bridge’s TTL for %s table', async (_, stage) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-01-01T00:00:00.000Z') });
    // Built once Date is faked, since the registry keeps the clock it is built with.
    const own = createTestCanvas();
    onTestFinished(() => shutdownCanvas(own));
    const t = newTenant();
    await stage(new CanvasBridge(own, { ttlMs: 90_000 }), t.call());
    const tables = await (await sharedCanvas(own, t.call())).describe();
    expect(tables.map((table) => table.expiresAt)).toEqual(['2026-01-01T00:01:30.000Z']);
  });

  it('carries the caller’s signal with a data tool’s rows', async () => {
    const registerTable = vi.spyOn(canvas.getProvider(), 'registerTable');
    const { signal } = new AbortController();
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    await bridge.register(newTenant().call({ signal }), stagedRows());
    expect(registerTable).toHaveBeenCalledOnce();
    expect(registerTable.mock.lastCall?.[4]?.signal).toBe(signal);
  });

  it('carries the caller’s signal with a query’s SQL', async () => {
    const query = vi.spyOn(canvas.getProvider(), 'query');
    const { signal } = new AbortController();
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    await bridge.query(newTenant().call({ signal }), 'SELECT 1', { rowLimit: 10 });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.lastCall?.[3]?.signal).toBe(signal);
  });
});

describe('the tenant’s one canvas', () => {
  it('lands five concurrent first stagings on one canvas, where all five answer and describe lists exactly them', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    const staged = await Promise.all(
      Array.from({ length: 5 }, () => bridge.register(t.call(), stagedRows())),
    );

    expect(canvas.countForTenant(t.call())).toBe(1);
    const names = staged.map((dataset) => dataset?.name ?? '').sort();
    expect(new Set(names).size).toBe(5);
    const answers = await Promise.all(
      names.map((name) =>
        bridge.query(t.call(), `SELECT max(refugees) AS n FROM ${name}`, { rowLimit: 10 }),
      ),
    );
    expect(answers.map(({ result }) => result.rows)).toEqual(
      Array.from({ length: 5 }, () => [{ n: 5952174 }]),
    );
    expect((await bridge.describe(t.call())).map((meta) => meta.tableName).sort()).toEqual(names);
    for (const name of names) {
      expect(await bridge.describe(t.call(), name), name).toHaveLength(1);
    }
  });

  it('reuses a bare id stored under canvas-id while its canvas is live', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    const stored = await canvas.acquire(undefined, t.call());
    await t.state.set('canvas-id', stored.canvasId);
    const staged = await bridge.register(t.call(), stagedRows());

    await expect(t.state.get('canvas-id')).resolves.toBe(stored.canvasId);
    expect(canvas.countForTenant(t.call())).toBe(1);
    expect((await stored.describe()).map((table) => table.name)).toEqual([staged?.name]);
  });

  it('answers SELECT 1 on a fresh process, minting the canvas the next call uses', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    const { result } = await bridge.query(t.call(), 'SELECT 1 AS n', { rowLimit: 10 });
    expect(result.rows).toEqual([{ n: 1 }]);
    await bridge.register(t.call(), stagedRows());
    expect(canvas.countForTenant(t.call())).toBe(1);
  });

  it('mints nothing on a fresh process for describe, drop, or a query naming a dataframe', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    await expect(bridge.describe(t.call())).resolves.toEqual([]);
    await expect(bridge.describe(t.call(), 'df_NOPE0_NOPE0')).resolves.toEqual([]);
    await expect(bridge.drop(t.call(), 'df_NOPE0_NOPE0')).resolves.toBe(false);
    await expect(
      bridge.query(t.call(), 'SELECT * FROM df_NOPE0_NOPE0', { rowLimit: 10 }),
    ).rejects.toMatchObject({ data: { reason: 'missing_table', tableName: 'df_NOPE0_NOPE0' } });
    expect(canvas.countForTenant(t.call())).toBe(0);
  });
});

describe('a dead canvas', () => {
  /** The idle TTL and absolute cap `createTestCanvas` gives its canvases, in minutes. */
  const IDLE_TTL_MIN = 60;
  const ABSOLUTE_CAP_MIN = 24 * 60;
  const opened: DataCanvas[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(opened.splice(0).map(shutdownCanvas));
  });

  /** Unexpired dataframes, `count` of them, whose canvas then dies. `minted` counts canvases made since. */
  async function deadCanvas(how: 'dropped' | 'past its absolute cap', count = 2) {
    const minutesPass = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);
    if (how === 'past its absolute cap') vi.useFakeTimers({ toFake: ['Date'] });
    // Built once Date is faked, since the registry keeps the clock it is built with.
    const own = createTestCanvas();
    opened.push(own);
    const bridge = new CanvasBridge(own, { ttlMs: 30 * 24 * 60 * 60_000 });
    const t = newTenant();
    const names: string[] = [];
    while (names.length < count) {
      names.push((await bridge.register(t.call(), stagedRows()))?.name ?? '');
    }
    const canvasId = (await t.state.get<string>('canvas-id')) ?? '';
    if (how === 'dropped') {
      await own.drop(canvasId, t.call());
    } else {
      // Kept in use, so the absolute cap ends it and not the idle TTL.
      const step = IDLE_TTL_MIN - 10;
      let minute = 0;
      for (; minute + step < ABSOLUTE_CAP_MIN; minute += step) {
        minutesPass(step);
        await own.acquire(canvasId, t.call());
      }
      minutesPass(ABSOLUTE_CAP_MIN - minute + 1);
    }
    const before = own.countForTenant(t.call());
    expect(await recordedNames(t.state)).toEqual([...names].sort());
    return {
      bridge,
      canvasId,
      minted: () => own.countForTenant(t.call()) - before,
      name: names[0] ?? '',
      t,
    };
  }

  describe.each(['dropped', 'past its absolute cap'] as const)('%s', (how) => {
    it.each(['in full', 'by name'])('is described as empty %s, minting nothing', async (form) => {
      const { bridge, minted, name, t } = await deadCanvas(how);
      await expect(
        bridge.describe(t.call(), ...(form === 'by name' ? [name] : [])),
      ).resolves.toEqual([]);
      expect(minted()).toBe(0);
      expect(await recordedNames(t.state)).toEqual([]);
    });

    it('fails a query naming one of its dataframes missing_table, minting nothing', async () => {
      const { bridge, minted, name, t } = await deadCanvas(how);
      await expect(
        bridge.query(t.call(), `SELECT * FROM ${name}`, { rowLimit: 10 }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: `Dataframe ${name} is not staged; it may have expired or been evicted to make room for newer dataframes.`,
        data: {
          reason: 'missing_table',
          tableName: name,
          recovery: {
            hint: 'Check the name against the dataset.name or register_as that created it; if it expired or was evicted, re-run the unhcr_get_* call that produced it.',
          },
        },
      });
      expect(minted()).toBe(0);
      expect(await recordedNames(t.state)).toEqual([]);
    });

    it('drops nothing, minting nothing', async () => {
      const { bridge, minted, name, t } = await deadCanvas(how);
      await expect(bridge.drop(t.call(), name)).resolves.toBe(false);
      expect(minted()).toBe(0);
      expect(await recordedNames(t.state)).toEqual([]);
    });

    it('is replaced by a SELECT that names no dataframe, its metadata gone', async () => {
      const { bridge, canvasId, minted, t } = await deadCanvas(how);
      const { result } = await bridge.query(t.call(), 'SELECT 1 AS n', { rowLimit: 10 });
      expect(result.rows).toEqual([{ n: 1 }]);
      expect(minted()).toBe(1);
      expect(await t.state.get('canvas-id')).not.toBe(canvasId);
      expect(await recordedNames(t.state)).toEqual([]);
    });

    it('is replaced by a staging, whose dataframe alone is listed and answers', async () => {
      const { bridge, minted, t } = await deadCanvas(how);
      const staged = await bridge.register(t.call(), stagedRows());
      expect(minted()).toBe(1);
      expect(await recordedNames(t.state)).toEqual([staged?.name]);
      expect((await bridge.describe(t.call())).map((meta) => meta.tableName)).toEqual([
        staged?.name,
      ]);
      const { result } = await bridge.query(
        t.call(),
        `SELECT year FROM ${staged?.name} ORDER BY 1`,
        { rowLimit: 10 },
      );
      expect(result.rows).toEqual([{ year: 2024 }, { year: 2025 }]);
    });
  });

  it('has the metadata of its only dataframe deleted', async () => {
    const { bridge, t } = await deadCanvas('dropped', 1);
    await expect(bridge.describe(t.call())).resolves.toEqual([]);
    expect(await recordedNames(t.state)).toEqual([]);
  });

  it('has every page of its metadata deleted', async () => {
    const { bridge, name, t } = await deadCanvas('dropped');
    const meta = await t.state.get<DataframeMeta>(`df-meta/${name}`);
    for (let i = 0; i < 205; i++) {
      const tableName = `df_PAGED_${String(i).padStart(5, '0')}`;
      await t.state.set(`df-meta/${tableName}`, { ...meta, tableName });
    }
    await expect(bridge.describe(t.call())).resolves.toEqual([]);
    expect(await recordedNames(t.state)).toEqual([]);
  });

  it('is replaced once by concurrent stagings, none of whose metadata the purge takes', async () => {
    const { bridge, minted, t } = await deadCanvas('dropped');
    const staged = await Promise.all(
      Array.from({ length: 4 }, () => bridge.register(t.call(), stagedRows())),
    );
    expect(minted()).toBe(1);
    expect(await recordedNames(t.state)).toEqual(staged.map((dataset) => dataset?.name).sort());
  });
});

describe('metadata of a canvas that is not the live one', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A staging of `rows` rows whose canvas is replaced, by a 2-row staging, before its metadata is written. */
  async function lateStaging(rows: number) {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });
    const t = newTenant();
    await bridge.query(t.call(), 'SELECT 1', { rowLimit: 1 });
    const { registered, release } = holdRegistration(canvas);
    const pending = bridge.register(t.call(), rowsOf(rows));
    await registered;
    await canvas.drop((await t.state.get<string>('canvas-id')) ?? '', t.call());
    const live = await bridge.register(t.call(), rowsOf(2));
    release();
    await pending;
    // Its metadata key is the one that is not the live staging's.
    const [late] = (await recordedNames(t.state)).filter((name) => name !== live?.name);
    return { bridge, late: late ?? '', live: live?.name ?? '', t };
  }

  it('written after the purge by a staging still in flight, is not listed, queried, or dropped', async () => {
    const { bridge, late, live, t } = await lateStaging(1);
    expect(late).toMatch(DATAFRAME_NAME);
    expect((await bridge.describe(t.call())).map((meta) => meta.tableName)).toEqual([live]);
    await expect(bridge.describe(t.call(), late)).resolves.toEqual([]);
    await expect(
      bridge.query(t.call(), `SELECT * FROM ${late}`, { rowLimit: 10 }),
    ).rejects.toMatchObject({ data: { reason: 'missing_table', tableName: late } });
    await expect(bridge.drop(t.call(), late)).resolves.toBe(false);
    const { result } = await bridge.query(t.call(), `SELECT count(*) AS n FROM ${live}`, {
      rowLimit: 10,
    });
    expect(Number(result.rows[0]?.n)).toBe(2);
  });

  it('never evicts from the live canvas, nor counts toward its budget', async () => {
    // 4 late rows and 2 live ones would exceed the 5-row budget if counted together.
    const { bridge, late, live, t } = await lateStaging(4);
    expect(late).toMatch(DATAFRAME_NAME);
    expect((await bridge.describe(t.call())).map((meta) => meta.tableName)).toEqual([live]);
    const next = await bridge.register(t.call(), rowsOf(3));
    expect(next).not.toHaveProperty('evicted');
    expect((await bridge.describe(t.call())).map((meta) => meta.tableName).sort()).toEqual(
      [live, next?.name].sort(),
    );
    // Still recorded, so the budget had it to count.
    expect(await recordedNames(t.state)).toContain(late);
  });

  it('naming no canvas at all, belongs to a dead one', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });
    const t = newTenant();
    const live = await bridge.register(t.call(), rowsOf(2));
    const { canvasId: _, ...unowned } = (await t.state.get<DataframeMeta>(
      `df-meta/${live?.name}`,
    )) as DataframeMeta;
    await t.state.set('df-meta/df_UNOWN_00001', {
      ...unowned,
      tableName: 'df_UNOWN_00001',
      rowCount: 4,
    });

    expect((await bridge.describe(t.call())).map((meta) => meta.tableName)).toEqual([live?.name]);
    await expect(bridge.describe(t.call(), 'df_UNOWN_00001')).resolves.toEqual([]);
    await expect(
      bridge.query(t.call(), 'SELECT * FROM df_UNOWN_00001', { rowLimit: 10 }),
    ).rejects.toMatchObject({ data: { reason: 'missing_table', tableName: 'df_UNOWN_00001' } });
    expect(await bridge.register(t.call(), rowsOf(3))).not.toHaveProperty('evicted');
  });

  it('is cleared once it expires, with no drop on the live canvas', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    const live = await bridge.register(t.call(), stagedRows());
    const meta = await t.state.get<DataframeMeta>(`df-meta/${live?.name}`);
    await t.state.set('df-meta/df_LATE0_00001', {
      ...meta,
      canvasId: 'AAAAAAAAAA',
      tableName: 'df_LATE0_00001',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const drop = vi.spyOn(canvas.getProvider(), 'drop');
    await bridge.describe(t.call());
    expect(await recordedNames(t.state)).toEqual([live?.name]);
    expect(drop).not.toHaveBeenCalled();
  });
});

describe('concurrent stagings over the budget, on storage that takes time', () => {
  const STATE_LATENCY_MS = 10;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A call each of whose storage operations takes {@link STATE_LATENCY_MS} on the fake clock. */
  const slow = {
    before: () => new Promise<void>((resolve) => setTimeout(resolve, STATE_LATENCY_MS)),
  };

  /** Run `work` to its end, a fake millisecond per event-loop turn so the engine's real work keeps pace. */
  async function onFakeClock<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    const done = Promise.allSettled([work]).then(() => {
      settled = true;
    });
    while (!settled) await vi.advanceTimersByTimeAsync(1);
    await done;
    return work;
  }

  const stageRows = (bridge: CanvasBridge, ctx: Context) =>
    bridge.register(ctx, rowsOf(3)).then((dataset) => dataset?.name);
  const registerRows = (bridge: CanvasBridge, ctx: Context, i: number) =>
    bridge
      .query(ctx, 'SELECT unnest(generate_series(1, 3)) AS n', {
        rowLimit: 10,
        registerAs: `df_RACER_0000${i}`,
      })
      .then(({ meta }) => meta?.tableName);

  // Three, so that a turn can pass to one waiter while another still waits.
  it.each([
    [2, 'data tool results', stageRows],
    [3, 'data tool results', stageRows],
    [2, 'register_as results', registerRows],
    [3, 'register_as results', registerRows],
  ])('leaves exactly one of %i %s and stays within the budget', async (calls, _, stage) => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000, rowBudget: 5 });
    const t = newTenant();
    await bridge.register(t.call(), rowsOf(1));
    const names = await onFakeClock(
      Promise.all(Array.from({ length: calls }, (_, i) => stage(bridge, t.call(slow), i))),
    );

    const left = await bridge.describe(t.call());
    const fresh = left.filter((meta) => names.includes(meta.tableName));
    expect(fresh).toHaveLength(1);
    expect(left.reduce((rows, meta) => rows + meta.rowCount, 0)).toBeLessThanOrEqual(5);
    // The one left answers, and the canvas holds nothing the metadata does not.
    const sql = `SELECT count(*) AS n FROM ${fresh[0]?.tableName}`;
    const { result } = await bridge.query(t.call(), sql, { rowLimit: 10 });
    expect(Number(result.rows[0]?.n)).toBe(3);
    expect(await canvasTables(t.call())).toEqual(left.map((meta) => meta.tableName).sort());
  });
});

describe('recording one dataframe at a time per tenant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bridgeOf = () => new CanvasBridge(canvas, { ttlMs: 60_000 });

  /** Tenants the bridge holds lock state for. */
  const tenantsHeld = (bridge: CanvasBridge): number =>
    Object.values(bridge).reduce((n, value) => n + (value instanceof Map ? value.size : 0), 0);

  interface HoldOptions {
    /** Where it stops: its metadata write, or the listing after it that its evictions start from. */
    at?: 'eviction' | 'write';
    signal?: AbortSignal;
  }

  /**
   * A call that stops inside its tenant's turn, `reached` resolving, until
   * `release()` lets the operation it stopped at happen or `fail()` makes it throw.
   */
  function heldCall(t: Tenant, { at = 'write', signal }: HoldOptions = {}) {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let wrote = false;
    const before: StateHook = async (operation, key) => {
      if (!key.startsWith('df-meta/')) return;
      const stopsHere = at === 'write' ? operation === 'set' : wrote && operation === 'list';
      wrote ||= operation === 'set';
      if (!stopsHere) return;
      reached.resolve();
      await gate.promise;
    };
    const ctx = t.call({ before, ...(signal && { signal }) });
    return { ctx, fail: gate.reject, reached: reached.promise, release: gate.resolve };
  }

  /** A staging stopped inside its tenant's turn. */
  async function holdTurn(bridge: CanvasBridge, t: Tenant, options?: HoldOptions) {
    const { ctx, reached, ...held } = heldCall(t, options);
    const staging = bridge.register(ctx, stagedRows());
    await reached;
    return { ...held, staging };
  }

  /** A staging whose rows the engine holds, once everything that can run without the turn has run. */
  async function arrive(bridge: CanvasBridge, ctx: Context) {
    const { registered, release } = holdRegistration(canvas);
    release();
    const staging = bridge.register(ctx, stagedRows());
    await registered;
    await turn();
    return { staging };
  }

  /** A staging whose rows the engine holds and which now waits for the tenant's turn. */
  async function queueStaging(bridge: CanvasBridge, ctx: Context) {
    const arrived = await arrive(bridge, ctx);
    expect(await settledWithin(arrived.staging)).toBe(false);
    return arrived;
  }

  /** A call that adds `label` to `written` as it starts a metadata write. */
  const writing = (t: Tenant, written: string[], label: string) =>
    t.call({
      before: (operation, key) => {
        if (operation === 'set' && key.startsWith('df-meta/')) written.push(label);
      },
    });

  it('keeps the turn through its evictions, so no other call records while one lists what to evict', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const holder = await holdTurn(bridge, t, { at: 'eviction' });
    const written: string[] = [];
    const behind = await arrive(bridge, writing(t, written, 'behind'));
    expect(written).toEqual([]);

    holder.release();
    const names = [(await holder.staging)?.name, (await behind.staging)?.name].sort();
    expect(written).toEqual(['behind']);
    expect(await recordedNames(t.state)).toEqual(names);
  });

  it('makes a call that arrives once the turn has passed on wait behind the one it passed to', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const first = await holdTurn(bridge, t);
    const held = heldCall(t);
    const second = await queueStaging(bridge, held.ctx);
    first.release();
    const firstName = (await first.staging)?.name;
    await held.reached;

    const third = await arrive(bridge, t.call());
    expect(await recordedNames(t.state)).toEqual([firstName]);

    held.release();
    const names = [firstName, (await second.staging)?.name, (await third.staging)?.name];
    expect(await recordedNames(t.state)).toEqual(names.sort());
    expect(tenantsHeld(bridge)).toBe(0);
  });

  it('gives the turn to waiting calls in the order they arrived', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const holder = await holdTurn(bridge, t);
    const written: string[] = [];
    const waiting: Promise<unknown>[] = [];
    for (const label of ['first', 'second', 'third']) {
      waiting.push((await queueStaging(bridge, writing(t, written, label))).staging);
    }

    holder.release();
    await Promise.all([holder.staging, ...waiting]);
    expect(written).toEqual(['first', 'second', 'third']);
  });

  it('lets a cancelled waiter go at once, while the turn is held, and fails neither call around it', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const holder = await holdTurn(bridge, t);
    const controller = new AbortController();
    const cancelled = await queueStaging(bridge, t.call({ signal: controller.signal }));
    const behind = await queueStaging(bridge, t.call());

    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    await expect(cancelled.staging).rejects.toBe(reason);
    expect(await settledWithin(holder.staging)).toBe(false);
    expect(await settledWithin(behind.staging)).toBe(false);

    holder.release();
    const names = [(await holder.staging)?.name, (await behind.staging)?.name].sort();
    expect((await bridge.describe(t.call())).map((meta) => meta.tableName).sort()).toEqual(names);
    expect(await canvasTables(t.call())).toEqual(names);
    expect(tenantsHeld(bridge)).toBe(0);
  });

  it('turns away a call cancelled before it reaches the queue, without making it wait', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const holder = await holdTurn(bridge, t);
    const controller = new AbortController();
    const { registered, release } = holdRegistration(canvas);
    const staging = bridge.register(t.call({ signal: controller.signal }), stagedRows());
    await registered;

    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    release();
    await expect(staging).rejects.toBe(reason);
    expect(await settledWithin(holder.staging)).toBe(false);

    holder.release();
    const held = await holder.staging;
    expect(held).toMatchObject({ row_count: 2 });
    expect(await canvasTables(t.call())).toEqual([held?.name]);
    expect(tenantsHeld(bridge)).toBe(0);
  });

  it('passes the turn on when the call holding it throws', async () => {
    const serverLog = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const bridge = bridgeOf();
    const t = newTenant();
    const holder = await holdTurn(bridge, t);
    const behind = await queueStaging(bridge, t.call());

    holder.fail(new Error('storage down'));
    await expect(holder.staging).resolves.toBeUndefined();
    const staged = await behind.staging;
    expect((await bridge.describe(t.call())).map((meta) => meta.tableName)).toEqual([staged?.name]);
    expect(await canvasTables(t.call())).toEqual([staged?.name]);
    expect(serverLog).toHaveBeenCalledWith(
      'Dataframe staging failed; the inline rows stand',
      expect.objectContaining({ extra: expect.objectContaining({ error: 'storage down' }) }),
    );
    expect(tenantsHeld(bridge)).toBe(0);
  });

  it('passes the turn on when the call holding it is cancelled', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const controller = new AbortController();
    const holder = await holdTurn(bridge, t, { signal: controller.signal });
    const behind = await queueStaging(bridge, t.call());

    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    holder.release();
    await expect(holder.staging).rejects.toBe(reason);
    const staged = await behind.staging;
    await expect(bridge.describe(t.call(), staged?.name)).resolves.toHaveLength(1);
    expect(tenantsHeld(bridge)).toBe(0);
  });

  it('never makes one tenant wait for another', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const other = newTenant();
    const holder = await holdTurn(bridge, t);
    const waiting = await queueStaging(bridge, t.call());

    await expect(bridge.register(other.call(), stagedRows())).resolves.toMatchObject({
      row_count: 2,
    });
    expect(await settledWithin(waiting.staging)).toBe(false);

    holder.release();
    await Promise.all([holder.staging, waiting.staging]);
  });

  it('keeps lock state only for a tenant with a recording underway', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const other = newTenant();
    const holder = await holdTurn(bridge, t);
    expect(tenantsHeld(bridge)).toBe(1);
    const second = await holdTurn(bridge, other);
    expect(tenantsHeld(bridge)).toBe(2);
    second.release();
    await second.staging;
    expect(tenantsHeld(bridge)).toBe(1);
    const waiting = await queueStaging(bridge, t.call());
    holder.release();
    await Promise.all([holder.staging, waiting.staging]);
    expect(tenantsHeld(bridge)).toBe(0);
  });

  it('holds a register_as result to the same turn as a data tool’s', async () => {
    const bridge = bridgeOf();
    const t = newTenant();
    const holder = await holdTurn(bridge, t);
    const described = Promise.withResolvers<void>();
    const provider = canvas.getProvider();
    const describeTables = provider.describe.bind(provider);
    vi.spyOn(provider, 'describe').mockImplementationOnce(async (...args) => {
      const tables = await describeTables(...args);
      described.resolve();
      return tables;
    });
    const registering = bridge.query(t.call(), 'SELECT 1 AS n', {
      rowLimit: 10,
      registerAs: 'df_TURNS_00001',
    });
    await described.promise;
    expect(await settledWithin(registering)).toBe(false);
    holder.release();
    await expect(registering).resolves.toMatchObject({ meta: { tableName: 'df_TURNS_00001' } });
    await holder.staging;
  });
});

describe('failure handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('latches a DuckDB load failure: staging returns nothing and no later call retries the load', async () => {
    const serverLog = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const { canvas: failing, acquireShared } = createFailingCanvas();
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const ctx = queryContext();

    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    expect(bridge.available).toBe(false);
    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    expect(acquireShared).toHaveBeenCalledTimes(1);

    const error = await bridge.query(ctx, 'SELECT 1', { rowLimit: 10 }).catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable', retryable: false },
    });
    expect(acquireShared).toHaveBeenCalledTimes(1);
    const warnings = (ctx.log as MockContextLogger).calls.filter(
      (call) => call.level === 'warning',
    );
    // The client-visible log gets a fixed line; the framework's text stays on the server.
    expect(warnings[0]).toEqual({
      level: 'warning',
      msg: 'DataCanvas unavailable: the DuckDB binding could not load',
      data: undefined,
    });
    expect(serverLog).toHaveBeenCalledWith(
      'DataCanvas unavailable: the DuckDB binding could not load',
      expect.objectContaining({
        extra: expect.objectContaining({ error: expect.stringContaining('@duckdb/node-api') }),
      }),
    );
  });

  it('keeps the bridge available after a staging failure that is not a load failure', async () => {
    const serverLog = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const { canvas: failing, acquireShared } = createFailingCanvas(new Error('disk full'));
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const ctx = queryContext();
    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    await expect(bridge.register(ctx, stagedRows())).resolves.toBeUndefined();
    expect(bridge.available).toBe(true);
    expect(acquireShared).toHaveBeenCalledTimes(2);
    const warnings = (ctx.log as MockContextLogger).calls.filter(
      (call) => call.level === 'warning',
    );
    // The client-visible log gets a fixed line; the engine's text stays on the server.
    expect(warnings[0]).toEqual({
      level: 'warning',
      msg: 'Dataframe staging failed; the inline rows stand',
      data: { sourceTool: 'unhcr_get_population' },
    });
    expect(serverLog).toHaveBeenCalledWith(
      'Dataframe staging failed; the inline rows stand',
      expect.objectContaining({
        extra: expect.objectContaining({ error: 'disk full', sourceTool: 'unhcr_get_population' }),
      }),
    );
  });

  it('keeps the bridge available after a mint the framework refuses, and the next call works', async () => {
    vi.spyOn(canvas.getProvider(), 'initCanvas').mockRejectedValueOnce(
      rateLimited('Tenant has reached the active canvas cap (500).'),
    );
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    await expect(bridge.register(t.call(), stagedRows())).resolves.toBeUndefined();
    expect(bridge.available).toBe(true);
    await expect(bridge.register(t.call(), stagedRows())).resolves.toMatchObject({ row_count: 2 });
  });

  it('fails the call that finds the binding cannot load canvas_unavailable, with the tool’s hint', async () => {
    const { canvas: failing } = createFailingCanvas();
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    await expect(bridge.query(queryContext(), 'SELECT 1', { rowLimit: 10 })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'Dataframes are unavailable in this deployment: the DuckDB engine could not load.',
      data: {
        reason: 'canvas_unavailable',
        retryable: false,
        recovery: {
          hint: "Dataframes are unavailable in this deployment, so retrying will not help; narrow the unhcr_get_* call's filters or year window so its rows fit inline.",
        },
      },
    });
    expect(bridge.available).toBe(false);
  });

  it.each([
    ['describe', (bridge: CanvasBridge, ctx: Context) => bridge.describe(ctx)],
    ['drop', (bridge: CanvasBridge, ctx: Context) => bridge.drop(ctx, 'df_NOPE0_NOPE0')],
    [
      'a query naming a dataframe',
      (bridge: CanvasBridge, ctx: Context) =>
        bridge.query(ctx, 'SELECT * FROM df_NOPE0_NOPE0', { rowLimit: 10 }),
    ],
  ])(
    'rejects %s when the stored canvas id cannot be read, never as if no canvas were live',
    async (_, run) => {
      const failure = new Error('storage down');
      const before: StateHook = (operation, key) => {
        if (operation === 'get' && key === 'canvas-id') throw failure;
      };
      const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
      await expect(run(bridge, newTenant().call({ before }))).rejects.toBe(failure);
    },
  );

  it('keeps a failed drop’s engine text and the table name out of the client-visible log', async () => {
    const serverLog = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const t = newTenant();
    const name = (await bridge.register(t.call(), stagedRows()))?.name ?? '';
    const meta = await t.state.get<DataframeMeta>(`df-meta/${name}`);
    await t.state.set(`df-meta/${name}`, { ...meta, expiresAt: '2000-01-01T00:00:00.000Z' });
    const engineText = `Catalog Error: Table with name ${name} is locked`;
    const drop = vi
      .spyOn(canvas.getProvider(), 'drop')
      .mockRejectedValueOnce(new Error(engineText));

    const ctx = t.call();
    await expect(bridge.describe(ctx)).resolves.toEqual([]);
    expect(drop).toHaveBeenCalledWith(meta?.canvasId, name, expect.anything());
    const logged = JSON.stringify((ctx.log as MockContextLogger).calls);
    expect(logged).toContain('Staged dataframe drop failed');
    expect(logged).not.toContain('Catalog Error');
    expect(logged).not.toContain(name);
    expect(serverLog).toHaveBeenCalledWith(
      'Staged dataframe drop failed',
      expect.objectContaining({ extra: expect.objectContaining({ error: engineText }) }),
    );
  });

  it('rethrows when the request was cancelled instead of swallowing the failure', async () => {
    const bridge = new CanvasBridge(canvas, { ttlMs: 60_000 });
    const controller = new AbortController();
    const ctx = queryContext(controller.signal);
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    await expect(bridge.register(ctx, stagedRows())).rejects.toBe(reason);
  });

  it('fails describe, drop, and query canvas_unavailable once latched off, without touching the canvas', async () => {
    const { canvas: failing, acquireShared } = createFailingCanvas();
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const t = newTenant();
    await bridge.register(t.call(), stagedRows());
    const unavailable = {
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable', retryable: false },
    };
    await expect(bridge.describe(t.call())).rejects.toMatchObject(unavailable);
    await expect(bridge.drop(t.call(), 'df_NOPE0_NOPE0')).rejects.toMatchObject(unavailable);
    await expect(
      bridge.query(t.call(), 'SELECT * FROM df_NOPE0_NOPE0', { rowLimit: 10 }),
    ).rejects.toMatchObject(unavailable);
    expect(acquireShared).toHaveBeenCalledTimes(1);
  });

  it('answers every concurrent first staging with nothing when the binding cannot load', async () => {
    const { canvas: failing } = createFailingCanvas();
    const bridge = new CanvasBridge(failing, { ttlMs: 60_000 });
    const t = newTenant();
    await expect(
      Promise.all(Array.from({ length: 3 }, () => bridge.register(t.call(), stagedRows()))),
    ).resolves.toEqual([undefined, undefined, undefined]);
    expect(bridge.available).toBe(false);
    expect(failing.countForTenant(t.call())).toBe(0);
  });
});
