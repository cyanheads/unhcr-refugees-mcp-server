/**
 * @fileoverview Count inputs (`limit`, `preview`, `row_limit`): one schema per
 * clamp mode and the one clamp every count input goes through. In the default
 * clamp mode a schema advertises a minimum and no maximum, and a value above
 * the cap is served at the cap with a notice, a log line, and a counter
 * increment; with `UNHCR_CLAMP_LIMITS=false` the schema advertises and
 * enforces the cap as its `maximum` instead.
 * @module mcp-server/tools/shared/counts
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

/**
 * An integer count of at least `min`. Clamp mode leaves the cap to
 * `clampCount()`: `z.number().int()` would advertise `Number.MAX_SAFE_INTEGER`
 * as its maximum, so integrality is a `multipleOf(1)` check typed `integer`.
 */
export function countSchema(min: number, cap: number, clamp: boolean) {
  return clamp
    ? z.number().multipleOf(1, 'Expected an integer').min(min).meta({ type: 'integer' })
    : z.number().int().min(min).max(cap);
}

/** The value a call is served with, plus the notice sentence when it was clamped. */
export interface CountClamp {
  effective: number;
  notice?: string;
}

/**
 * Created on first clamp, not at import: `createCounter` reads the framework
 * config, which must not be parsed before `src/index.ts` loads `.env`.
 */
let clampCounter: ReturnType<typeof createCounter> | undefined;

/**
 * Serve `requested` at `cap` when it is larger. A clamp logs once at info and
 * adds one to `unhcr.count_input.clamped`, attributed to the tool and field.
 */
export function clampCount(
  ctx: Context,
  input: { tool: string; field: string; requested: number; cap: number },
): CountClamp {
  const { tool, field, requested, cap } = input;
  if (requested <= cap) return { effective: requested };
  ctx.log.info('Count input clamped', { tool, field, requested, effective: cap });
  clampCounter ??= createCounter(
    'unhcr.count_input.clamped',
    'Count inputs served at their cap because the caller asked for more',
    '{call}',
  );
  clampCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'unhcr.count_input.field': field });
  return { effective: cap, notice: `Requested ${field} ${requested}; effective ${field} ${cap}.` };
}
