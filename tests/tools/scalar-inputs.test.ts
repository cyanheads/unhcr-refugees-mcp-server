/** Tests the scalar forms parsed by the registered tool definitions. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { errorOf, structuredOf, textOf, unescapeMarkdown } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

const tools = (normalizeInputs: boolean, clampLimits = true) =>
  buildToolDefinitions({ clampLimits, normalizeInputs, dropEnabled: false, rowLimitCap: 10_000 });
const query = (normalizeInputs: boolean, clampLimits = true) =>
  tools(normalizeInputs, clampLimits).find((tool) => tool.name === 'unhcr_dataframe_query')!;
const sql = 'SELECT n FROM (VALUES (1), (2), (3)) t(n) ORDER BY n';

describe('deployed scalar argument schemas', () => {
  it.each([true, false])(
    'keeps blank, typed, and text input semantics (normalize %s)',
    (enabled) => {
      for (const tool of tools(enabled).filter(({ name }) => name.startsWith('unhcr_get_'))) {
        expect(tool.input.parse({ limit: ' ', stage: '', year_from: '\t' })).toMatchObject({
          limit: 25,
          stage: false,
        });
        expect(
          tool.input.parse({ limit: 5, stage: true, year_from: 2025, origin: '2025' }),
        ).toMatchObject({ limit: 5, stage: true, year_from: 2025, origin: '2025' });
      }
      expect(query(enabled).input.parse({ sql, preview: '\t', row_limit: ' ' })).toMatchObject({
        sql,
        row_limit: 1000,
      });
    },
  );

  it.each(['01', '1e3', '1.0', '-0', '+1', '0x10', 'Infinity', 'NaN', '1.5'])(
    'rejects a noncanonical number or noninteger %s',
    (value) => {
      expect(query(true).input.safeParse({ sql, preview: value }).success).toBe(false);
    },
  );

  it.each(['TRUE', 'yes', '0', '1', 'False'])('rejects a noncanonical boolean %s', (value) => {
    const population = tools(true).find((tool) => tool.name === 'unhcr_get_population')!;
    expect(population.input.safeParse({ include_nowcast: value }).success).toBe(false);
    expect(population.input.safeParse({ stage: value }).success).toBe(false);
  });
});

describe('scalar input normalization on both tool response surfaces', () => {
  const canvas = createTestCanvas();

  beforeAll(() => initCanvasBridge(canvas));
  afterAll(() => shutdownCanvas(canvas));
  beforeEach(() => initFakeUpstream());
  afterEach(() => disposeUnhcrService());

  for (const name of [
    'unhcr_get_population',
    'unhcr_get_demographics',
    'unhcr_get_asylum_applications',
    'unhcr_get_asylum_decisions',
    'unhcr_get_solutions',
  ]) {
    it(`${name} reads trimmed years, limit, and stage like their typed values`, async () => {
      const definition = tools(true).find((tool) => tool.name === name)!;
      const typed = await runToolContract(definition, {
        origin: 'SYR',
        year_from: 2025,
        year_to: 2025,
        limit: 10,
        stage: false,
        ...(name === 'unhcr_get_population' && { include_nowcast: true }),
      });
      const spelled = await runToolContract(definition, {
        origin: 'SYR',
        year_from: ' 2025 ',
        year_to: '2025',
        limit: '10',
        stage: 'false',
        ...(name === 'unhcr_get_population' && { include_nowcast: ' true ' }),
      });
      expect(structuredOf(spelled)).toEqual(structuredOf(typed));
      expect(spelled.content).toEqual(typed.content);
    });
  }

  it.each([
    [sql, 0, 2, [], 2],
    [sql, 5, 2, [{ n: 1 }, { n: 2 }], 2],
    [`${sql} OFFSET 4`, 2, 2, [], 0],
  ])('reads SQL counts for %s', async (statement, preview, row_limit, rows, row_count) => {
    const typed = await runToolContract(query(true), { sql: statement, preview, row_limit });
    const spelled = await runToolContract(query(true), {
      sql: statement,
      preview: String(preview),
      row_limit: String(row_limit),
    });
    expect(structuredOf(spelled)).toMatchObject({ rows, row_count });
    expect(structuredOf(spelled)).toEqual(structuredOf(typed));
    expect(spelled.content).toEqual(typed.content);
  });

  it('preserves the rejection when normalization is off', async () => {
    const result = await runToolContract(query(false), { sql, preview: '0' });
    const error = errorOf(result);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(error.message).toContain('preview: Invalid input: expected number, received string');
    expect(unescapeMarkdown(textOf(result.content))).toContain(error.message);
  });

  it('records only conversions that pass their field schema, even when a sibling rejects', async () => {
    using log = vi.spyOn(logger, 'info');
    const rejected = await runToolContract(query(true), { sql, row_limit: '01', preview: '0' });
    const error = errorOf(rejected);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('row_limit: Invalid input: expected number, received string');
    expect(error.message).not.toContain('preview:');
    expect(unescapeMarkdown(textOf(rejected.content))).toContain(error.message);
    expect(log.mock.calls).toEqual([['Scalar input normalized: preview']]);

    log.mockClear();
    const outOfBounds = await runToolContract(query(true, false), {
      sql,
      preview: '1501',
      row_limit: '10001',
    });
    expect(errorOf(outOfBounds).message).toContain(
      'preview: Too big: expected number to be <=1500',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps the clamp notice when an over-cap value is spelled as a string', async () => {
    const result = await runToolContract(query(true), { sql, row_limit: '10001' });
    expect(structuredOf(result)).toMatchObject({
      rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
      notice: 'Requested row_limit 10001; effective row_limit 10000.',
    });
    expect(textOf(result.content)).toContain(
      'Requested row_limit 10001; effective row_limit 10000.',
    );
  });

  it('stages a result when the stage flag is spelled as true', async () => {
    const population = tools(true).find((tool) => tool.name === 'unhcr_get_population')!;
    const call = await runToolContract(population, {
      origin: 'SYR',
      asylum: 'DEU',
      year_from: '2025',
      year_to: '2025',
      stage: ' true ',
    });
    const result = structuredOf(call);
    expect(result).toMatchObject({
      total_rows: 1,
      dataset: { name: expect.stringMatching(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/), row_count: 1 },
    });
    const dataset = result.dataset as { name: string };
    expect(textOf(call.content)).toContain(dataset.name);
  });
});
