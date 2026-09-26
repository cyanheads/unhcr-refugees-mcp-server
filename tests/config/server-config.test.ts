/**
 * @fileoverview Tests for the server's env-driven configuration: defaults, the
 * `z.stringbool()` drop flag (so `false` actually disables it), and range
 * rejections that name the environment variable. The config is parsed once per
 * module instance, so each case imports a fresh module.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadConfig = async () => {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
};

const VARS = [
  'UNHCR_REQUESTS_PER_SECOND',
  'UNHCR_MAX_ROWS',
  'UNHCR_CACHE_MAX_MB',
  'UNHCR_DATASET_TTL_SECONDS',
  'UNHCR_DATAFRAME_DROP_ENABLED',
];

const clearVars = () => {
  for (const name of VARS) vi.stubEnv(name, undefined);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('applies the documented defaults', async () => {
    clearVars();
    const getServerConfig = await loadConfig();
    expect(getServerConfig()).toEqual({
      requestsPerSecond: 4,
      maxRows: 150_000,
      cacheMaxMb: 64,
      datasetTtlSeconds: 86_400,
      dataframeDropEnabled: false,
    });
  });

  it('parses every variable, and parses once', async () => {
    clearVars();
    vi.stubEnv('UNHCR_REQUESTS_PER_SECOND', '10');
    vi.stubEnv('UNHCR_MAX_ROWS', '10000');
    vi.stubEnv('UNHCR_CACHE_MAX_MB', '0');
    vi.stubEnv('UNHCR_DATASET_TTL_SECONDS', '60');
    vi.stubEnv('UNHCR_DATAFRAME_DROP_ENABLED', 'true');
    const getServerConfig = await loadConfig();
    const config = getServerConfig();
    expect(config).toEqual({
      requestsPerSecond: 10,
      maxRows: 10_000,
      cacheMaxMb: 0,
      datasetTtlSeconds: 60,
      dataframeDropEnabled: true,
    });
    vi.stubEnv('UNHCR_MAX_ROWS', '20000');
    expect(getServerConfig()).toBe(config);
  });

  it('reads UNHCR_DATAFRAME_DROP_ENABLED=false as off, not as a truthy string', async () => {
    clearVars();
    vi.stubEnv('UNHCR_DATAFRAME_DROP_ENABLED', 'false');
    const getServerConfig = await loadConfig();
    expect(getServerConfig().dataframeDropEnabled).toBe(false);
  });

  it.each([
    ['UNHCR_REQUESTS_PER_SECOND', '11'],
    ['UNHCR_REQUESTS_PER_SECOND', '0'],
    ['UNHCR_MAX_ROWS', '9999'],
    ['UNHCR_MAX_ROWS', '500001'],
    ['UNHCR_CACHE_MAX_MB', '-1'],
    ['UNHCR_DATASET_TTL_SECONDS', '59'],
    ['UNHCR_DATAFRAME_DROP_ENABLED', 'maybe'],
  ])('rejects %s=%s with a configuration error naming the variable', async (name, value) => {
    clearVars();
    vi.stubEnv(name, value);
    const getServerConfig = await loadConfig();
    let thrown: unknown;
    try {
      getServerConfig();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect(String((thrown as Error).message)).toContain(name);
  });
});
