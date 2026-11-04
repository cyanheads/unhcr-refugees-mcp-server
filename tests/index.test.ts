/**
 * @fileoverview Tests for the server entry point. `createApp()` is the process
 * boundary — it would start a transport — so it is replaced with a spy that
 * captures the options `src/index.ts` passes: the identity, the registered
 * tools (all six data and reference tools plus the dataframe tools), the
 * stateless session posture, the server instructions, and the setup and
 * teardown hooks that build and release the services, with dataframe listing
 * off for an unauthenticated HTTP deployment. The entry point reads
 * `.env` from the working directory, so every import runs from a temporary
 * directory the test controls; the `.env` cases cover the dataframe default,
 * the drop flag, `UNHCR_CLAMP_LIMITS`, and the canvas row cap reaching the
 * tool schemas.
 * @module tests/index.test
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type createApp as CreateApp, z } from '@cyanheads/mcp-ts-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { ATTRIBUTION_SOURCE, DATA_LICENSE, DATASETS, TERMS_URL } from '@/services/unhcr/codes.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { createTestCanvas, shutdownCanvas } from './helpers/services.js';

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

  it('serves the root skills/ tree, and every skill the instructions point to is in it', () => {
    expect(options.skills).toBe('skills');
    const pointed = [
      ...(options.instructions ?? '').matchAll(/skill:\/\/([a-z0-9-]+)\/SKILL\.md/g),
    ].map((match) => match[1]);
    expect(pointed).toEqual(['unhcr-refugees-guide']);
    for (const name of pointed) {
      expect(existsSync(join(originalCwd, 'skills', name ?? '', 'SKILL.md')), name).toBe(true);
    }
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

  it('gives the 25-row default and the clamp, and names no byte budget or result chunks', () => {
    expect(instructions()).toContain(
      'Inline rows default to 25 (limit, preview), and a count above its cap returns the cap with a notice.',
    );
    for (const term of ['result_chunks', 'byte', 'chunk_index', 'base64'])
      expect(instructions(), term).not.toContain(term);
  });
});

describe('lifecycle hooks', () => {
  type SetupCore = {
    canvas?: unknown;
    config: { mcpAuthMode: 'jwt' | 'none' | 'oauth'; mcpTransportType: 'http' | 'stdio' };
  };
  const setup = (core: SetupCore) => (options.setup as (core: SetupCore) => void)(core);

  it('builds the UNHCR service and the canvas bridge in setup, and releases the service in teardown', async () => {
    const teardown = options.teardown as () => Promise<void> | void;
    setup({ canvas: undefined, config: { mcpTransportType: 'stdio', mcpAuthMode: 'none' } });
    expect(getUnhcrService()).toBeDefined();
    expect(getCanvasBridge()).toBeUndefined();
    await teardown();
    expect(() => getUnhcrService()).toThrow(/not initialized/);
  });

  it.each([
    ['http', 'none', false],
    ['http', 'jwt', true],
    ['http', 'oauth', true],
    ['stdio', 'none', true],
  ] as const)(
    'turns dataframe listing off only for unauthenticated HTTP (%s, auth %s → listing %s)',
    async (mcpTransportType, mcpAuthMode, listing) => {
      const canvas = createTestCanvas();
      try {
        setup({ canvas, config: { mcpTransportType, mcpAuthMode } });
        expect(getCanvasBridge()?.listingEnabled).toBe(listing);
      } finally {
        await (options.teardown as () => Promise<void> | void)();
        await shutdownCanvas(canvas);
      }
    },
  );
});

describe('.env in the working directory', () => {
  const ENV_KEYS = [
    'CANVAS_PROVIDER_TYPE',
    'CANVAS_DEFAULT_ROW_LIMIT',
    'UNHCR_CLAMP_LIMITS',
    'UNHCR_DATAFRAME_DROP_ENABLED',
  ] as const;
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

  /** A loaded tool's count input as `tools/list` advertises it. */
  const countInput = (loaded: AppOptions, toolName: string, field: string) => {
    const tool = loaded.tools?.find((candidate) => candidate.name === toolName);
    const schema = z.toJSONSchema(tool!.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    return schema.properties[field];
  };

  it('turns clamping off with UNHCR_CLAMP_LIMITS=false: every count input advertises its cap', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'UNHCR_CLAMP_LIMITS=false\n');
    const loaded = await importEntry(dir);
    expect(countInput(loaded, 'unhcr_get_population', 'limit')).toMatchObject({ maximum: 2_000 });
    expect(countInput(loaded, 'unhcr_dataframe_query', 'preview')).toMatchObject({
      maximum: 1_500,
    });
    expect(countInput(loaded, 'unhcr_dataframe_query', 'row_limit')).toMatchObject({
      maximum: 10_000,
    });
    expect(loaded.instructions).toContain('a count above its cap is rejected');
  });

  it('carries CANVAS_DEFAULT_ROW_LIMIT into the row_limit default', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'CANVAS_DEFAULT_ROW_LIMIT=500\n');
    const loaded = await importEntry(dir);
    const rowLimit = countInput(loaded, 'unhcr_dataframe_query', 'row_limit');
    expect(rowLimit).toMatchObject({ default: 500 });
    expect(rowLimit).not.toHaveProperty('maximum');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the unsubstituted install-template placeholder is the input under test
  it.each(['${CANVAS_PROVIDER_TYPE}', '  '])(
    'reads CANVAS_PROVIDER_TYPE=%j as unset and keeps dataframes on',
    async (value) => {
      process.env.CANVAS_PROVIDER_TYPE = value;
      await importEntry(tempDir());
      expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
    },
  );
});
