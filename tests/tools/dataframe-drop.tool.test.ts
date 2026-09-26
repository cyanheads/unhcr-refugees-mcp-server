/**
 * @fileoverview Tests for unhcr_dataframe_drop over a real in-memory DuckDB
 * canvas: an idempotent drop on both surfaces, the dropped table gone from
 * describe and query, canvas_unavailable, and name validation.
 * @module tests/tools/dataframe-drop.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { carryDataframeState, flowContext, stagePopulation } from '../helpers/dataframes.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

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

const dropIn = (ctx: ReturnType<typeof flowContext>, name: string) =>
  dataframeDropTool.handler(dataframeDropTool.input.parse({ name }), ctx);

describe('unhcr_dataframe_drop', () => {
  it('drops a staged dataframe so describe and query no longer see it, and is idempotent', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR', asylum: 'DEU' });

    const dropped = await dropIn(flow, name);
    expect(dropped).toEqual({ name, dropped: true });
    expect(textOf(dataframeDropTool.format!(dropped))).toBe(`Dropped ${name}.`);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({}),
      flow,
    );
    expect(described.dataframes).toEqual([]);
    await expect(
      dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: `SELECT * FROM ${name}` }),
        flow,
      ),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });

    const again = await dropIn(flow, name);
    expect(again).toEqual({ name, dropped: false });
    expect(textOf(dataframeDropTool.format!(again))).toBe(
      `${name} was not staged; nothing was dropped.`,
    );
  });

  it('drops through the production pipeline when the dataframe was staged by an earlier call', async () => {
    const flow = flowContext();
    const name = await stagePopulation(flow, { origin: 'SYR' });
    const seeded: typeof dataframeDropTool = {
      ...dataframeDropTool,
      handler: async (input, ctx) => {
        await carryDataframeState(flow, ctx);
        return dataframeDropTool.handler(input, ctx);
      },
    };
    const result = await runToolContract(seeded, { name });
    expect(structuredOf(result)).toEqual({ name, dropped: true });
    expect(textOf(result.content)).toBe(`Dropped ${name}.`);
  });

  it('reports dropped: false for a well-formed name that was never staged', async () => {
    const result = await runToolContract(dataframeDropTool, { name: 'df_NEVER_STAGE' });
    expect(structuredOf(result)).toEqual({ name: 'df_NEVER_STAGE', dropped: false });
  });

  it('fails canvas_unavailable, not retryable, when the deployment has no canvas', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(dataframeDropTool, { name: 'df_ABCDE_12345' });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        retryable: false,
        recovery: {
          hint: 'Dataframes are unavailable in this deployment, so nothing is staged to drop and retrying will not help.',
        },
      },
    });
    expect(textOf(result.content)).not.toContain('unhcr_get_');
  });

  it('rejects a missing or malformed name as invalid params', async () => {
    for (const input of [{}, { name: '' }, { name: 'df_abcde_12345' }, { name: 'refugees' }]) {
      const result = await runToolContract(dataframeDropTool, input as { name: string });
      expect(errorOf(result).code, JSON.stringify(input)).toBe(JsonRpcErrorCode.InvalidParams);
    }
  });
});
