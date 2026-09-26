/**
 * @fileoverview Adapter between the unhcr_* tools and the framework DataCanvas.
 * Keeps one shared canvas per tenant (its id in `ctx.state` under
 * `canvas-id`), mints `df_XXXXX_XXXXX` table names, records provenance and
 * expiry in `ctx.state` (`df-meta/<name>`), and lazily sweeps expired
 * metadata on every operation. Registration is best-effort: any failure logs a
 * warning and returns nothing, so the calling data tool keeps its inline rows.
 * A `ConfigurationError` from the lazy DuckDB load (the native binding is
 * absent, as in the `.mcpb` bundle) is latched once as "canvas unavailable",
 * and every later call takes the canvas-off path. Queries run through the
 * framework's read-only SQL gate with system catalogs denied, and the gate's
 * rejections are rebuilt with this server's recovery hints.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  ColumnSchema,
  DataCanvas,
  QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import type { Provider } from '@/services/unhcr/codes.js';

/** Provenance and schema for one staged dataframe, persisted in `ctx.state`. */
export interface DataframeMeta {
  columnSchema: ColumnSchema[];
  /** `false` when the row cap stopped the upstream fetch that produced the rows. */
  complete: boolean;
  createdAt: string;
  expiresAt: string;
  /** Third-party series the rows carry, for attribution downstream. */
  providers: Provider[];
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
}

/** What a data tool reports about a staged result (`dataset` output field). */
export interface StagedDataset {
  expires_at: string;
  name: string;
  row_count: number;
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
  preview?: number;
  registerAs?: string;
  rowLimit: number;
}

/** Result of {@link CanvasBridge.query}. */
export interface BridgeQueryResult {
  /** Metadata of the dataframe `registerAs` created, when set. */
  meta?: DataframeMeta;
  /** Union of the providers recorded for every dataframe the SQL references. */
  providers: Provider[];
  result: QueryResult;
}

/** Shape of a minted dataframe name. */
export const DATAFRAME_NAME = /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/;

const META_PREFIX = 'df-meta/';
const CANVAS_ID_KEY = 'canvas-id';
const NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** DuckDB resolves identifiers case-insensitively, so a handle matches in any case. */
const HANDLE_IN_SQL = /\bdf_[a-z0-9]{5}_[a-z0-9]{5}\b/gi;
/**
 * Spans that cannot hold a table reference: single-quoted string literals and
 * line or block comments, matched in one pass so a comment marker inside a
 * string (or a quote inside a comment) is read as part of its own span.
 * Double quotes are left alone: in DuckDB they delimit identifiers, and a
 * quoted handle is still a reference.
 */
const NON_REFERENCE_SPANS = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

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
  const handles = sql.replace(NON_REFERENCE_SPANS, ' ').match(HANDLE_IN_SQL) ?? [];
  return [...new Set(handles.map((handle) => `df_${handle.slice(3).toUpperCase()}`))];
}

/** The pointer every response carrying a `dataset` handle includes. */
export function dataframeGuidance(dataset: StagedDataset): string {
  return `Full set staged as ${dataset.name} (${dataset.row_count} rows). Use unhcr_dataframe_describe to inspect its columns, then unhcr_dataframe_query to analyze it with SQL.`;
}

export class CanvasBridge {
  private latchedOff = false;

  constructor(
    private readonly canvas: DataCanvas,
    private readonly options: { ttlMs: number },
  ) {}

  /** `false` once the DuckDB binding has failed to load. */
  get available(): boolean {
    return !this.latchedOff;
  }

  /**
   * Stage rows as a new `df_<id>` table. Returns `undefined` on any failure so
   * the caller keeps its inline answer; only a cancelled request rethrows.
   */
  async register(ctx: Context, options: RegisterOptions): Promise<StagedDataset | undefined> {
    if (this.latchedOff || options.rows.length === 0) return;
    try {
      await this.sweepExpired(ctx);
      const instance = await this.acquireSharedCanvas(ctx);
      const tableName = this.mintName();
      const result = await instance.registerTable(tableName, options.rows, {
        schema: options.schema,
        ttlMs: this.options.ttlMs,
        signal: ctx.signal,
      });
      const createdAt = Date.now();
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + this.options.ttlMs).toISOString(),
        rowCount: result.rowCount,
        complete: options.complete,
        providers: options.providers,
        columnSchema: options.schema,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
      ctx.log.info('Dataframe staged', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });
      return { name: meta.tableName, row_count: meta.rowCount, expires_at: meta.expiresAt };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('Dataframe staging failed; the inline rows stand', {
        sourceTool: options.sourceTool,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  /** Staged dataframes, newest first; one when `name` is given. Expired entries are swept first. */
  async describe(ctx: Context, name?: string): Promise<DataframeMeta[]> {
    await this.sweepExpired(ctx);
    if (name !== undefined) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${name}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Run one read-only SELECT on the shared canvas. A referenced `df_<id>` that
   * is not staged fails as `missing_table` before the gate runs; the gate's own
   * rejections are rebuilt with the calling tool's recovery hints. With
   * `registerAs`, the result is saved as a new dataframe with a fresh TTL.
   */
  async query(ctx: Context, sql: string, options: BridgeQueryOptions): Promise<BridgeQueryResult> {
    await this.sweepExpired(ctx);
    const referenced: DataframeMeta[] = [];
    for (const name of referencedDataframes(sql)) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${name}`);
      if (!meta) {
        throw notFound(`Dataframe ${name} is not staged; it may have expired.`, {
          reason: 'missing_table',
          tableName: name,
          ...ctx.recoveryFor('missing_table'),
        });
      }
      referenced.push(meta);
    }

    const instance = await this.acquireSharedCanvas(ctx);
    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        rowLimit: options.rowLimit,
        ...(options.preview !== undefined && { preview: options.preview }),
        ...(options.registerAs !== undefined && {
          registerAs: options.registerAs,
          ttlMs: this.options.ttlMs,
        }),
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (error) {
      throw this.rewrapQueryError(error, ctx);
    }

    const providers = [...new Set(referenced.flatMap((meta) => meta.providers))].sort();
    if (!options.registerAs || !result.tableName) return { result, providers };

    const [info] = await instance.describe({ tableName: result.tableName });
    const createdAt = Date.now();
    const meta: DataframeMeta = {
      tableName: result.tableName,
      sourceTool: 'unhcr_dataframe_query',
      queryParams: { sql },
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.options.ttlMs).toISOString(),
      rowCount: result.rowCount,
      complete: referenced.every((parent) => parent.complete),
      providers,
      columnSchema: info?.columns ?? [],
    };
    await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
    return { result, meta, providers };
  }

  /** Idempotent drop of the table and its metadata; `true` when either existed. */
  async drop(ctx: Context, name: string): Promise<boolean> {
    await this.sweepExpired(ctx);
    const key = `${META_PREFIX}${name}`;
    const hadMeta = (await ctx.state.get(key)) !== null;
    await ctx.state.delete(key);
    const instance = await this.acquireSharedCanvas(ctx);
    const dropped = await instance.drop(name);
    return dropped || hadMeta;
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

  /** Drop tables whose recorded expiry has passed and delete their metadata. */
  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      if (!this.latchedOff) {
        instance ??= await this.acquireSharedCanvas(ctx);
        await instance.drop(meta.tableName).catch((error: unknown) => {
          ctx.log.warning('Expired dataframe drop failed', {
            tableName: meta.tableName,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      await ctx.state.delete(key);
    }
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

  /**
   * The tenant's shared canvas: the stored id while it is live, a fresh canvas
   * otherwise. A `ConfigurationError` here is the DuckDB binding failing to
   * load, latched so no later call tries again.
   */
  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    if (this.latchedOff) throw this.unavailableError(ctx);
    try {
      const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
      if (stored) {
        const existing = await this.canvas.acquire(stored, ctx).catch((error: unknown) => {
          if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError) {
            throw error;
          }
          return;
        });
        if (existing) return existing;
      }
      const instance = await this.canvas.acquire(undefined, ctx);
      await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
      return instance;
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError) {
        this.latchedOff = true;
        ctx.log.warning('DataCanvas unavailable: the DuckDB binding could not load', {
          error: error.message,
        });
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
  options: { ttlMs: number } = { ttlMs: 86_400_000 },
): CanvasBridge | undefined {
  _bridge = canvas ? new CanvasBridge(canvas, options) : undefined;
  return _bridge;
}

/** The bridge, or `undefined` when no canvas exists. Check `available` before use. */
export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}
