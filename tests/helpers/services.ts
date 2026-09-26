/**
 * @fileoverview Test wiring for the two service seams the design's Test
 * Boundary names: `UnhcrApiService` built over the fake upstream's `fetch`,
 * and `CanvasBridge` over a real in-memory DuckDB `DataCanvas` (or a stub
 * whose `acquire` fails, for the binding-load latch).
 * @module tests/helpers/services
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { vi } from 'vitest';
import {
  initUnhcrService,
  type UnhcrApiService,
  type UnhcrServiceConfig,
} from '@/services/unhcr/unhcr-api-service.js';
import { createFakeUnhcr, type FakeUnhcr, type FakeUnhcrOptions } from './fake-unhcr.js';

/** A pacer budget high enough that no test request ever waits. */
export const TEST_SERVICE_CONFIG: UnhcrServiceConfig = {
  requestsPerSecond: 1000,
  maxRows: 150_000,
  cacheMaxBytes: 64 * 1024 * 1024,
};

/** Initialize the service singleton over a fresh fake upstream. */
export function initFakeUpstream(
  options: FakeUnhcrOptions & { config?: Partial<UnhcrServiceConfig> } = {},
): { fake: FakeUnhcr; service: UnhcrApiService } {
  const fake = createFakeUnhcr(options);
  const service = initUnhcrService({
    fetch: fake.fetch,
    config: { ...TEST_SERVICE_CONFIG, ...options.config },
  });
  return { fake, service };
}

/** A real DuckDB-backed canvas, in memory, with the background sweeper off. */
export function createTestCanvas(): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 10_000,
    exportRootPath: join(tmpdir(), 'unhcr-refugees-test-exports'),
    memoryLimitMb: 256,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    ttlMs: 60 * 60_000,
    absoluteCapMs: 24 * 60 * 60_000,
    maxCanvasesPerTenant: 10_000,
    sweeperIntervalMs: 0,
  });
  return new DataCanvas(provider, registry);
}

/** Tear a test canvas down. */
export async function shutdownCanvas(canvas: DataCanvas): Promise<void> {
  await canvas.shutdown(createMockContext());
}

/**
 * A `DataCanvas` whose `acquire` fails the way the framework's lazy DuckDB load
 * does when the native binding is absent (`ConfigurationError`), or with any
 * other error when one is given.
 */
export function createFailingCanvas(error?: Error) {
  const acquire = vi.fn(() =>
    Promise.reject(
      error ??
        configurationError(
          'Install "@duckdb/node-api" to use the DuckDB canvas provider: bun add @duckdb/node-api',
        ),
    ),
  );
  const canvas: Pick<DataCanvas, 'acquire'> = { acquire };
  return { acquire, canvas: canvas as DataCanvas };
}
