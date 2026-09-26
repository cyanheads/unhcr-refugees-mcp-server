/**
 * @fileoverview Helpers for multi-call dataframe flows. In production every
 * tool call gets a fresh context over the same persistent tenant storage, so a
 * dataframe one call stages is visible to the next. Each mock context owns its
 * own in-memory store instead, so a flow either shares one context across
 * handlers (with the union of their error contracts) or carries the dataframe
 * bookkeeping — the shared canvas id and the `df-meta/` entries — into the
 * fresh context `runToolContract` builds.
 * @module tests/helpers/dataframes
 */

import type { Context, z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';

/** One context every tool in a staging → describe → query → drop flow accepts. */
export const flowContext = () =>
  createMockContext({
    errors: [
      ...getPopulationTool.errors!,
      ...dataframeDescribeTool.errors!,
      ...dataframeQueryTool.errors!,
      ...dataframeDropTool.errors!,
    ],
  });

/** Stage a population result and return its dataframe handle. */
export async function stagePopulation(
  ctx: ReturnType<typeof flowContext>,
  input: z.input<typeof getPopulationTool.input>,
): Promise<string> {
  const result = await getPopulationTool.handler(
    getPopulationTool.input.parse({ ...input, stage: true }),
    ctx,
  );
  if (!result.dataset) throw new Error('Expected the population result to be staged');
  return result.dataset.name;
}

/** Copy the dataframe bookkeeping from one context's tenant storage into another's. */
export async function carryDataframeState(from: Context, to: Context): Promise<void> {
  const canvasId = await from.state.get<string>('canvas-id');
  if (canvasId) await to.state.set('canvas-id', canvasId);
  let cursor: string | undefined;
  do {
    const page = await from.state.list('df-meta/', {
      ...(cursor !== undefined && { cursor }),
      limit: 100,
    });
    for (const item of page.items) await to.state.set(item.key, item.value);
    cursor = page.cursor;
  } while (cursor);
}
