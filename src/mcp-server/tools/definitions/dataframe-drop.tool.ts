/**
 * @fileoverview unhcr_dataframe_drop — drops a staged dataframe before its TTL.
 * Idempotent. Registered through `disabledTool()` unless
 * `UNHCR_DATAFRAME_DROP_ENABLED=true`, since the per-table TTL reclaims staged
 * tables on its own.
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DATAFRAME_NAME,
  DATAFRAME_NAME_LENGTH,
  getCanvasBridge,
} from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDropTool = tool('unhcr_dataframe_drop', {
  title: 'Drop a staged dataframe',
  description:
    'Drop a staged dataframe by name before its TTL expires. Idempotent: returns dropped=false when nothing matched. Re-running the unhcr_get_* call that staged it restores the rows under a new name.',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: z
      .string()
      .max(DATAFRAME_NAME_LENGTH)
      .regex(DATAFRAME_NAME)
      .describe(
        'Dataframe to drop, as df_XXXXX_XXXXX (uppercase letters and digits): the dataset.name a unhcr_get_* result returned, or a register_as name.',
      ),
  }),

  output: z.object({
    name: z.string().describe('The dataframe name requested.'),
    dropped: z
      .boolean()
      .describe('True when the dataframe existed and was removed; false when nothing matched.'),
  }),

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      severity: 'warning',
      when: 'Dataframes are turned off in this deployment, or the SQL engine behind them could not load',
      recovery:
        'Dataframes are unavailable in this deployment, so nothing is staged to drop and retrying will not help.',
    },
  ],

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge?.available) {
      throw ctx.fail('canvas_unavailable', 'Dataframes are unavailable in this deployment.');
    }
    const dropped = await bridge.drop(ctx, input.name);
    ctx.log.info('Dataframe drop requested', { name: input.name, dropped });
    return { name: input.name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped ${result.name}.`
        : `${result.name} was not staged; nothing was dropped.`,
    },
  ],
});
