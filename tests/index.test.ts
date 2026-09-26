/**
 * @fileoverview Tests for the server entry point. `createApp()` is the process
 * boundary — it would start a transport — so it is replaced with a spy that
 * captures the options `src/index.ts` passes: the identity, the registered
 * tools (all six data and reference tools plus the dataframe tools), the
 * stateless session posture, the server instructions, and the setup and
 * teardown hooks that build and release the services. The entry point reads
 * `.env` from the working directory, so every import runs from a temporary
 * directory the test controls.
 * @module tests/index.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createApp as CreateApp } from '@cyanheads/mcp-ts-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { ATTRIBUTION_SOURCE, DATA_LICENSE, DATASETS, TERMS_URL } from '@/services/unhcr/codes.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';

const createApp = vi.hoisted(() => vi.fn());

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

type AppOptions = NonNullable<Parameters<typeof CreateApp>[0]>;

const originalCwd = process.cwd();
const tempDirs: string[] = [];

/** A fresh, empty working directory. */
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'unhcr-entry-'));
  tempDirs.push(dir);
  return dir;
};

/** Import the entry point from `cwd` and return the options it passed to `createApp()`. */
async function importEntry(cwd: string): Promise<AppOptions> {
  createApp.mockClear();
  process.chdir(cwd);
  try {
    await import('@/index.js');
  } finally {
    process.chdir(originalCwd);
  }
  expect(createApp).toHaveBeenCalledTimes(1);
  return createApp.mock.calls[0]?.[0] as AppOptions;
}

let options: AppOptions;

beforeAll(async () => {
  delete process.env.CANVAS_PROVIDER_TYPE;
  options = await importEntry(tempDir());
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const toolNames = () => (options.tools ?? []).map((tool) => tool.name);

/** The tools that return UNHCR figures, from the datasets table. */
const DATA_TOOLS = [...new Set(DATASETS.map((info) => info.tool))];

describe('createApp options', () => {
  it('identifies the server by its hyphenated repo name, stateless, with no resources or prompts', () => {
    expect(options).toMatchObject({
      name: 'unhcr-refugees-mcp-server',
      title: 'unhcr-refugees-mcp-server',
      sessionMode: 'stateless',
      resources: [],
      prompts: [],
    });
  });

  it('registers every data tool, the reference tool, and the dataframe tools, each once', () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      ...DATA_TOOLS,
      'unhcr_list_reference',
      'unhcr_dataframe_describe',
      'unhcr_dataframe_query',
      'unhcr_dataframe_drop',
    ]) {
      expect(names, name).toContain(name);
    }
    expect(DATA_TOOLS).toEqual(
      expect.arrayContaining([
        'unhcr_get_demographics',
        'unhcr_get_asylum_applications',
        'unhcr_get_asylum_decisions',
      ]),
    );
  });

  it('turns dataframes on by default before the app is built', () => {
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
  });
});

describe('server instructions', () => {
  const instructions = () => options.instructions ?? '';

  it('fits the 2,048-character budget', () => {
    expect(instructions().length).toBeGreaterThan(0);
    expect(instructions().length).toBeLessThanOrEqual(2048);
  });

  it('names every tool a client can list, and never the off-by-default drop tool', () => {
    for (const name of toolNames().filter((tool) => tool !== 'unhcr_dataframe_drop')) {
      expect(instructions(), name).toContain(name);
    }
    expect(instructions()).not.toContain('unhcr_dataframe_drop');
  });

  it('gives each dataset’s first year but hard-codes no latest year, which each result carries', () => {
    for (const firstYear of ['1951', '2000', '2001', '1959']) {
      expect(instructions()).toContain(firstYear);
    }
    const years = (instructions().match(/\b(19|20)\d\d\b/g) ?? []).map(Number);
    expect(years.filter((year) => year > 2001)).toEqual([]);
    expect(instructions()).toContain('latest_year');
  });

  it('separates stocks from flows', () => {
    expect(instructions()).toMatch(/\bstocks?\b/);
    expect(instructions()).toMatch(/\bflows?\b/);
  });

  it('carries the attribution and terms UNHCR requires, and disclaims endorsement', () => {
    expect(instructions()).toContain(ATTRIBUTION_SOURCE);
    expect(instructions()).toContain(TERMS_URL);
    expect(instructions()).toContain(DATA_LICENSE);
    expect(instructions()).toMatch(/not endorsed/);
  });
});

describe('lifecycle hooks', () => {
  it('builds the UNHCR service and the canvas bridge in setup, and releases the service in teardown', async () => {
    const setup = options.setup as (core: { canvas?: unknown }) => void;
    const teardown = options.teardown as () => Promise<void> | void;
    setup({ canvas: undefined });
    expect(getUnhcrService()).toBeDefined();
    expect(getCanvasBridge()).toBeUndefined();
    await teardown();
    expect(() => getUnhcrService()).toThrow(/not initialized/);
  });
});

describe('.env in the working directory', () => {
  const ENV_KEYS = ['CANVAS_PROVIDER_TYPE', 'UNHCR_DATAFRAME_DROP_ENABLED'] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The drop tool definition from the module registry the entry point just loaded. */
  const liveDropTool = async () =>
    (await import('@/mcp-server/tools/definitions/dataframe-drop.tool.js')).dataframeDropTool;

  it('is loaded before the server config and the dataframe default are read', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, '.env'),
      'UNHCR_DATAFRAME_DROP_ENABLED=true\nCANVAS_PROVIDER_TYPE=none\n',
    );
    const loaded = await importEntry(dir);
    expect(loaded.tools).toContain(await liveDropTool());
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('none');
  });

  it('is optional: without one the drop tool stays disabled and dataframes stay on', async () => {
    const loaded = await importEntry(tempDir());
    const drop = loaded.tools?.find((tool) => tool.name === 'unhcr_dataframe_drop');
    expect(drop).toBeDefined();
    expect(drop).not.toBe(await liveDropTool());
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
  });
});
