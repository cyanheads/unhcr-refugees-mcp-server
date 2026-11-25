/**
 * @fileoverview Adapter between the unhcr_* tools and the framework DataCanvas.
 * Keeps one shared canvas per tenant through `DataCanvas.acquireShared` (its id
 * in `ctx.state` under `canvas-id`), mints `df_XXXXX_XXXXX` table names, records
 * provenance and expiry in `ctx.state` (`df-meta/<name>`), and lazily sweeps
 * expired metadata on every operation. Metadata names the canvas its table is
 * on: all of it is deleted when that canvas is found dead, and whatever names
 * another canvas than the live one is never read. Each tenant's staged rows are
 * held to a budget: once a new dataframe exists, the oldest others are evicted
 * until the total fits, one recording at a time per tenant. Registration is
 * best-effort: any failure logs a warning and returns nothing, so the calling
 * data tool keeps its inline rows. A `ConfigurationError` from the lazy DuckDB
 * load (the native binding is absent, as in the `.mcpb` bundle) is latched once
 * as "canvas unavailable", and every later call takes the canvas-off path.
 * Queries run through the framework's read-only SQL gate with system catalogs
 * denied, and the gate's rejections are rebuilt with this server's recovery
 * hints. Engine error text goes to the server-only logger; `ctx.log` reaches
 * the client, so it gets fixed messages.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  ColumnSchema,
  DataCanvas,
  DescribedColumn,
  QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { idGenerator, logger, withExtra } from '@cyanheads/mcp-ts-core/utils';
import type { Provider } from '@/services/unhcr/codes.js';

/** Provenance and schema for one staged dataframe, persisted in `ctx.state`. */
export interface DataframeMeta {
  /** Canvas the table is on. Metadata naming another canvas than the live one, or none, is of a dead canvas. */
  canvasId: string;
  /** A data tool's columns as registered; a `registerAs` result's as the engine describes them, `engineType` included. */
  columnSchema: DescribedColumn[];
  /** `false` when the row cap stopped the upstream fetch that produced the rows. */
  complete: boolean;
  createdAt: string;
  expiresAt: string;
  /** Original incomplete upstream handles, retained independently of ancestor lifetime. */
  incompleteSources: string[];
  /** Third-party series the rows carry, for attribution downstream. */
  providers: Provider[];
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
}

/** What a data tool reports about a staged result (`dataset` output field). */
export interface StagedDataset {
  /** Dataframes dropped, oldest first, to keep the tenant within its staging budget. */
  evicted?: string[];
  expires_at: string;
  name: string;
  row_count: number;
}

/** Construction options for {@link CanvasBridge}. */
export interface CanvasBridgeOptions {
  /** `false` refuses to list every staged dataframe; lookups by name still work. Default `true`. */
  listing?: boolean;
  /** Most rows a tenant may hold staged at once. Default {@link DEFAULT_STAGED_ROW_BUDGET}. */
  rowBudget?: number;
  ttlMs: number;
}

/** Input to {@link CanvasBridge.register}. */
export interface RegisterOptions {
  complete: boolean;
  providers: Provider[];
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
  schema: ColumnSchema[];
  sourceTool: string;
}

/** Input to {@link CanvasBridge.query}. */
export interface BridgeQueryOptions {
  registerAs?: string;
  rowLimit: number;
}

/** Result of {@link CanvasBridge.query}. */
export interface BridgeQueryResult {
  complete: boolean;
  /** Dataframes the `registerAs` result evicted to keep the tenant within its staging budget. */
  evicted?: string[];
  incompleteSources: string[];
  /** Metadata of the dataframe `registerAs` created, when set. */
  meta?: DataframeMeta;
  /** Union of the providers recorded for every dataframe the SQL references. */
  providers: Provider[];
  result: QueryResult;
}

/** Shape of a minted dataframe name. */
export const DATAFRAME_NAME = /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/;
/** Length of every name {@link DATAFRAME_NAME} matches, as the explicit bound on name inputs. */
export const DATAFRAME_NAME_LENGTH = 14;
/**
 * Rows one tenant may hold staged across all its dataframes: twice the largest
 * `UNHCR_MAX_ROWS`, so the biggest stage a data tool can make still leaves
 * room for others.
 */
export const DEFAULT_STAGED_ROW_BUDGET = 1_000_000;

const META_PREFIX = 'df-meta/';
const CANVAS_ID_KEY = 'canvas-id';
const NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** DuckDB resolves identifiers case-insensitively, so a handle matches in any case. */
const HANDLE_IN_SQL = /^df_[a-z0-9]{5}_[a-z0-9]{5}$/i;
/**
 * Spans that cannot hold a table reference: single-quoted string literals and
 * line or block comments, matched in one pass so a comment marker inside a
 * string (or a quote inside a comment) is read as part of its own span.
 * Double quotes are left alone: in DuckDB they delimit identifiers, and a
 * quoted handle is still a reference.
 */
const SQL_TOKENS =
  /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-z_][a-z0-9_]*|[^\s]/gi;

/**
 * Framework gate and engine reasons, mapped onto the reasons
 * `unhcr_dataframe_query` declares. Aliases fold into the declared reason whose
 * recovery fits.
 */
const QUERY_REASONS: Record<string, string> = {
  missing_table: 'missing_table',
  invalid_sql: 'invalid_sql',
  sql_parse_error: 'invalid_sql',
  sql_execution_error: 'sql_execution_error',
  register_as_clash: 'register_as_clash',
  non_select_statement: 'non_select_statement',
  sql_read_only: 'non_select_statement',
  multi_statement: 'multi_statement',
  denied_function: 'denied_function',
  denied_function_in_plan: 'denied_function',
  plan_operator_not_allowed: 'plan_operator_not_allowed',
  system_catalog_access: 'system_catalog_access',
};

/**
 * Dataframe handles an SQL statement references, in canonical `df_XXXXX_XXXXX`
 * form and de-duplicated. Handles inside string literals and comments are not
 * references; quoted identifiers and any letter case are.
 */
export function referencedDataframes(sql: string): string[] {
  const handles = new Set<string>();
  const pending = [sql];
  for (const statement of pending) {
    let previous = '';
    let beforePrevious = '';
    for (const match of statement.matchAll(SQL_TOKENS)) {
      const token = match[0];
      if (token.startsWith('--') || token.startsWith('/*')) continue;
      const identifier = token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token;
      if (token.startsWith("'")) {
        if (previous === '(' && beforePrevious.toLowerCase() === 'query') {
          pending.push(token.slice(1, -1).replaceAll("''", "'"));
        }
      } else if (HANDLE_IN_SQL.test(identifier)) {
        handles.add(`df_${identifier.slice(3).toUpperCase()}`);
      }
      beforePrevious = previous;
      previous = identifier;
    }
  }
  return [...handles];
}

/** The pointer every response carrying a `dataset` handle includes. */
export function dataframeGuidance(dataset: StagedDataset): string {
  return `Full set staged as ${dataset.name} (${dataset.row_count} rows). Use unhcr_dataframe_describe to inspect its columns, then unhcr_dataframe_query to analyze it with SQL.`;
}

/** An error's message, for the server-only log. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const count = (n: number): string => n.toLocaleString('en-US');

/**
 * Join `queue` and wait to be called. A waiter whose signal aborts first leaves
 * the queue and rejects with the signal's reason, without waiting for its turn.
 */
async function waitInQueue(queue: (() => void)[], signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const leave = () => {
    const index = queue.indexOf(resolve);
    if (index !== -1) queue.splice(index, 1);
    reject(signal.reason);
  };
  queue.push(resolve);
  signal.addEventListener('abort', leave, { once: true });
  try {
    await promise;
  } finally {
    signal.removeEventListener('abort', leave);
  }
}

export class CanvasBridge {
  private latchedOff = false;
  private readonly listing: boolean;
  /**
   * Calls waiting behind the recording underway for a tenant. An entry exists
   * only while one runs: the last call out deletes it.
   */
  private readonly recordQueues = new Map<string, (() => void)[]>();
  private readonly rowBudget: number;
  private readonly ttlMs: number;

  constructor(
    private readonly canvas: DataCanvas,
    options: CanvasBridgeOptions,
  ) {
    this.listing = options.listing ?? true;
    this.rowBudget = options.rowBudget ?? DEFAULT_STAGED_ROW_BUDGET;
    this.ttlMs = options.ttlMs;
  }

  /** `false` once the DuckDB binding has failed to load. */
  get available(): boolean {
    return !this.latchedOff;
  }

  /** `false` when the deployment refuses to list every staged dataframe. */
  get listingEnabled(): boolean {
    return this.listing;
  }

  /**
   * Stage rows as a new `df_<id>` table, then evict the tenant's oldest others
   * while its staged rows exceed the budget. Returns `undefined` on any failure
   * so the caller keeps its inline answer; only a cancelled request rethrows.
   */
  async register(ctx: Context, options: RegisterOptions): Promise<StagedDataset | undefined> {
    if (this.latchedOff || options.rows.length === 0) return;
    try {
      const instance = await this.acquireSharedCanvas(ctx);
      await this.sweepExpired(ctx, instance);
      const tableName = this.mintName();
      const result = await instance.registerTable(tableName, options.rows, {
        schema: options.schema,
        ttlMs: this.ttlMs,
        signal: ctx.signal,
      });
      const createdAt = Date.now();
      const meta: DataframeMeta = {
        canvasId: instance.canvasId,
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + this.ttlMs).toISOString(),
        rowCount: result.rowCount,
        complete: options.complete,
        incompleteSources: options.complete ? [] : [result.tableName],
        providers: options.providers,
        columnSchema: options.schema,
      };
      const evicted = await this.recordWithinBudget(ctx, instance, meta);
      ctx.log.info('Dataframe staged', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });
      return {
        name: meta.tableName,
        row_count: meta.rowCount,
        expires_at: meta.expiresAt,
        ...(evicted.length > 0 && { evicted }),
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const message = 'Dataframe staging failed; the inline rows stand';
      ctx.log.warning(message, { sourceTool: options.sourceTool });
      logger.warning(
        message,
        withExtra(ctx, { sourceTool: options.sourceTool, error: errorText(error) }),
      );
      return;
    }
  }

  /**
   * Dataframes staged on the live canvas, newest first; one when `name` is
   * given, none when no canvas is live. Expired entries are swept first.
   */
  async describe(ctx: Context, name?: string): Promise<DataframeMeta[]> {
    const instance = await this.acquireSharedCanvas(ctx, { create: false });
    if (!instance) return [];
    await this.sweepExpired(ctx, instance);
    if (name !== undefined) {
      const meta = await this.readMeta(ctx, instance, name);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateLiveMeta(ctx, instance)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Run one read-only SELECT on the shared canvas, minting it only when the SQL
   * names no dataframe. A referenced `df_<id>` that is not staged fails as
   * `missing_table` before the gate runs; the gate's own rejections are rebuilt
   * with the calling tool's recovery hints. With `registerAs`, the result is
   * saved as a new dataframe with a fresh TTL and the budget evicts the oldest
   * others; a result that alone exceeds the budget is dropped and fails
   * `register_as_too_large`, evicting nothing.
   */
  async query(ctx: Context, sql: string, options: BridgeQueryOptions): Promise<BridgeQueryResult> {
    const names = referencedDataframes(sql);
    const [firstName] = names;
    let instance: CanvasInstance | undefined;
    if (firstName === undefined) {
      instance = await this.acquireSharedCanvas(ctx);
    } else {
      instance = await this.acquireSharedCanvas(ctx, { create: false });
      if (!instance) throw this.missingTable(ctx, firstName);
    }
    await this.sweepExpired(ctx, instance);
    const referenced: DataframeMeta[] = [];
    for (const name of names) {
      const meta = await this.readMeta(ctx, instance, name);
      if (!meta) throw this.missingTable(ctx, name);
      referenced.push(meta);
    }

    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        rowLimit: options.rowLimit,
        ...(options.registerAs !== undefined && {
          registerAs: options.registerAs,
          ttlMs: this.ttlMs,
        }),
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (error) {
      throw this.rewrapQueryError(error, ctx);
    }

    const providers = [...new Set(referenced.flatMap((meta) => meta.providers))].sort();
    const incompleteSources = [
      ...new Set(referenced.flatMap((meta) => meta.incompleteSources)),
    ].sort();
    const provenance = { complete: incompleteSources.length === 0, incompleteSources };
    if (!options.registerAs || !result.tableName) return { result, providers, ...provenance };

    // On the registerAs path the provider counts the saved table, so rowCount is exact.
    if (result.rowCount > this.rowBudget) {
      await this.dropTable(ctx, instance, result.tableName);
      throw validationError(
        `The register_as result has ${count(result.rowCount)} rows, more than the ${count(this.rowBudget)}-row staging budget, so it was not saved.`,
        {
          reason: 'register_as_too_large',
          rowCount: result.rowCount,
          rowBudget: this.rowBudget,
          ...ctx.recoveryFor('register_as_too_large'),
        },
      );
    }

    const [info] = await instance.describe({ tableName: result.tableName });
    const createdAt = Date.now();
    const meta: DataframeMeta = {
      canvasId: instance.canvasId,
      tableName: result.tableName,
      sourceTool: 'unhcr_dataframe_query',
      queryParams: { sql },
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.ttlMs).toISOString(),
      rowCount: result.rowCount,
      complete: provenance.complete,
      incompleteSources,
      providers,
      columnSchema: info?.columns ?? [],
    };
    const evicted = await this.recordWithinBudget(ctx, instance, meta);
    return { result, meta, providers, ...provenance, ...(evicted.length > 0 && { evicted }) };
  }

  /** Idempotent drop of the table and its metadata on the live canvas; `true` when either existed. */
  async drop(ctx: Context, name: string): Promise<boolean> {
    const instance = await this.acquireSharedCanvas(ctx, { create: false });
    if (!instance) return false;
    await this.sweepExpired(ctx, instance);
    const meta = await this.readMeta(ctx, instance, name);
    if (meta) await ctx.state.delete(`${META_PREFIX}${name}`);
    const dropped = await instance.drop(name);
    return dropped || meta !== undefined;
  }

  /** The `missing_table` failure for a dataframe that is not staged on the live canvas. */
  private missingTable(ctx: Context, name: string): McpError {
    return notFound(
      `Dataframe ${name} is not staged; it may have expired or been evicted to make room for newer dataframes.`,
      { reason: 'missing_table', tableName: name, ...ctx.recoveryFor('missing_table') },
    );
  }

  /** Rebuild a gate or engine rejection with the declared reason and its recovery. */
  private rewrapQueryError(error: unknown, ctx: Context): unknown {
    if (!(error instanceof McpError)) return error;
    const data = error.data ?? {};
    const reason = typeof data.reason === 'string' ? QUERY_REASONS[data.reason] : undefined;
    if (!reason) return error;
    return new McpError(
      error.code,
      error.message,
      { ...data, reason, ...ctx.recoveryFor(reason) },
      { cause: error },
    );
  }

  /** Delete metadata whose recorded expiry has passed, dropping the tables that are on `instance`. */
  private async sweepExpired(ctx: Context, instance: CanvasInstance): Promise<void> {
    const nowIso = new Date().toISOString();
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      if (meta.canvasId === instance.canvasId) {
        await this.dropTable(ctx, instance, meta.tableName);
      }
      await ctx.state.delete(key);
    }
  }

  /**
   * Record a dataframe that exists on `instance`, then evict the tenant's
   * oldest others while its staged rows exceed the budget. One call at a time
   * per tenant, so each counts every dataframe recorded before it and two
   * concurrent ones cannot each evict the other. A table that cannot be
   * recorded is dropped: the budget would not count it, and no caller has its
   * name. Returns the evicted names.
   */
  private async recordWithinBudget(
    ctx: Context,
    instance: CanvasInstance,
    meta: DataframeMeta,
  ): Promise<string[]> {
    let recorded = false;
    try {
      return await this.inRecordTurn(instance.tenantId, ctx.signal, async () => {
        await ctx.state.set(`${META_PREFIX}${meta.tableName}`, meta);
        recorded = true;
        return await this.evictOverBudget(ctx, instance, meta.tableName);
      });
    } catch (error) {
      if (!recorded) await this.dropTable(ctx, instance, meta.tableName);
      throw error;
    }
  }

  /** Run `work` alone among a tenant's recordings, rejecting without a turn once `signal` aborts. */
  private async inRecordTurn<T>(
    tenantId: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const running = this.recordQueues.get(tenantId);
    const queue = running ?? [];
    if (running) await waitInQueue(running, signal);
    else this.recordQueues.set(tenantId, queue);
    try {
      return await work();
    } finally {
      const next = queue.shift();
      if (next) next();
      else this.recordQueues.delete(tenantId);
    }
  }

  /**
   * Drop the oldest dataframes on `instance`, never `keep`, until its staged
   * rows fit the budget, deleting their metadata. Runs once `keep` exists, so
   * its real row count is counted and the tables its SQL read have been read.
   * Returns the evicted names, oldest first. The log line carries a count, not
   * names: under a shared tenant they are other callers' handles.
   */
  private async evictOverBudget(
    ctx: Context,
    instance: CanvasInstance,
    keep: string,
  ): Promise<string[]> {
    const staged: { key: string; meta: DataframeMeta }[] = [];
    for await (const entry of this.iterateLiveMeta(ctx, instance)) staged.push(entry);
    let total = staged.reduce((sum, { meta }) => sum + meta.rowCount, 0);
    const evicted: string[] = [];
    staged.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));
    for (const { key, meta } of staged) {
      if (total <= this.rowBudget) break;
      if (meta.tableName === keep) continue;
      // Metadata first: a cancelled call stops at its next state operation, never with the table gone and its metadata kept.
      await ctx.state.delete(key);
      await this.dropTable(ctx, instance, meta.tableName);
      total -= meta.rowCount;
      evicted.push(meta.tableName);
    }
    if (evicted.length > 0) {
      ctx.log.info('Dataframes evicted to stay within the staging budget', {
        evictedCount: evicted.length,
        stagedRows: total,
        rowBudget: this.rowBudget,
      });
    }
    return evicted;
  }

  /**
   * Drop one table. A failure is logged, never thrown: the client-visible line
   * is fixed, and the engine's text goes to the server-only log.
   */
  private async dropTable(
    ctx: Context,
    instance: CanvasInstance,
    tableName: string,
  ): Promise<void> {
    await instance.drop(tableName).catch((error: unknown) => {
      const message = 'Staged dataframe drop failed';
      ctx.log.warning(message);
      logger.warning(message, withExtra(ctx, { error: errorText(error) }));
    });
  }

  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined && { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  /** Metadata of the dataframes on `instance`. */
  private async *iterateLiveMeta(
    ctx: Context,
    instance: CanvasInstance,
  ): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    for await (const entry of this.iterateMeta(ctx)) {
      if (entry.meta.canvasId === instance.canvasId) yield entry;
    }
  }

  /** One dataframe's metadata, when it is on `instance`. */
  private async readMeta(
    ctx: Context,
    instance: CanvasInstance,
    name: string,
  ): Promise<DataframeMeta | undefined> {
    const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${name}`);
    return meta?.canvasId === instance.canvasId ? meta : undefined;
  }

  /** Delete every dataframe's metadata: the canvas the tables were on is gone. */
  private async purgeMeta(ctx: Context): Promise<void> {
    const keys: string[] = [];
    for await (const { key } of this.iterateMeta(ctx)) keys.push(key);
    if (keys.length > 0) await ctx.state.deleteMany(keys);
  }

  /**
   * The tenant's shared canvas, minted when none is live unless `create` is
   * `false`. Finding none live purges the metadata kept for the dead one,
   * before any caller obtains a replacement. A `ConfigurationError` here is the
   * DuckDB binding failing to load, latched so no later call tries again.
   */
  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance>;
  private async acquireSharedCanvas(
    ctx: Context,
    options: { create: false },
  ): Promise<CanvasInstance | undefined>;
  private async acquireSharedCanvas(
    ctx: Context,
    { create = true }: { create?: boolean } = {},
  ): Promise<CanvasInstance | undefined> {
    if (this.latchedOff) throw this.unavailableError(ctx);
    try {
      return await this.canvas.acquireShared(ctx, {
        create,
        onReplace: () => this.purgeMeta(ctx),
        stateKey: CANVAS_ID_KEY,
      });
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError) {
        this.latchedOff = true;
        const message = 'DataCanvas unavailable: the DuckDB binding could not load';
        ctx.log.warning(message);
        logger.warning(message, withExtra(ctx, { error: errorText(error) }));
        throw this.unavailableError(ctx, error);
      }
      throw error;
    }
  }

  private unavailableError(ctx: Context, cause?: unknown): McpError {
    return serviceUnavailable(
      'Dataframes are unavailable in this deployment: the DuckDB engine could not load.',
      { reason: 'canvas_unavailable', retryable: false, ...ctx.recoveryFor('canvas_unavailable') },
      cause === undefined ? undefined : { cause },
    );
  }

  /** Mint a `df_XXXXX_XXXXX` name (~3.7 × 10^15 keyspace). */
  private mintName(): string {
    const part = () => idGenerator.generateRandomString(5, NAME_CHARSET);
    return `df_${part()}_${part()}`;
  }
}

let _bridge: CanvasBridge | undefined;

/**
 * Wire the bridge during `setup()`. `canvas` is `undefined` when the framework
 * built no DataCanvas (`CANVAS_PROVIDER_TYPE=none`, or Workers).
 */
export function initCanvasBridge(
  canvas: DataCanvas | undefined,
  options: CanvasBridgeOptions = { ttlMs: 86_400_000 },
): CanvasBridge | undefined {
  _bridge = canvas ? new CanvasBridge(canvas, options) : undefined;
  return _bridge;
}

/** The bridge, or `undefined` when no canvas exists. Check `available` before use. */
export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}
