/**
 * @fileoverview The tool list handed to `createApp()`. The count inputs
 * (`limit`, `preview`, `row_limit`) and the list inputs (`stages`,
 * `decision_levels`, `population_types`, `split_by`) take their schema here,
 * per deployment: tool modules evaluate before `src/index.ts` loads `.env`, so
 * the clamp mode (`UNHCR_CLAMP_LIMITS`), the normalize mode
 * (`UNHCR_NORMALIZE_INPUTS`), and the canvas row cap reach the schemas through
 * these options rather than at import. The module constants stay the
 * default-mode definitions. The drop tool stays in the list in every
 * deployment: when `UNHCR_DATAFRAME_DROP_ENABLED` is off it is wrapped with
 * `disabledTool()`, which keeps it out of MCP registration (clients cannot
 * list or call it) while the HTTP landing page still shows it with the
 * setting that turns it on.
 * @module mcp-server/tools/definitions/index
 */

import { disabledTool, type ToolDefinition, tool, type z } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { limitInput } from '../shared/inputs.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { defineDataframeQueryTool } from './dataframe-query.tool.js';
import { applicationLists, getAsylumApplicationsTool } from './get-asylum-applications.tool.js';
import { decisionLists, getAsylumDecisionsTool } from './get-asylum-decisions.tool.js';
import { demographicLists, getDemographicsTool } from './get-demographics.tool.js';
import { getPopulationTool } from './get-population.tool.js';
import { getSolutionsTool } from './get-solutions.tool.js';
import { listReferenceTool } from './list-reference.tool.js';

/** Deployment settings that decide how a tool enters the registration list. */
export interface ToolDefinitionOptions {
  /**
   * `UNHCR_CLAMP_LIMITS`: true serves a count above its cap at the cap with a
   * notice; false advertises each cap as a schema `maximum` and rejects past it.
   */
  clampLimits: boolean;
  /** `UNHCR_DATAFRAME_DROP_ENABLED`: register `unhcr_dataframe_drop` live instead of disabled. */
  dropEnabled: boolean;
  /**
   * `UNHCR_NORMALIZE_INPUTS`: true reads a list input sent as a string as the
   * array of its codes, and `split_by` in any case; false rejects both.
   */
  normalizeInputs: boolean;
  /** The canvas row cap (`CANVAS_DEFAULT_ROW_LIMIT`), which caps `unhcr_dataframe_query`'s `row_limit`. */
  rowLimitCap: number;
}

/**
 * A data tool rebuilt with the deployment's schema for each input named in
 * `inputs`, in place; every other field is the module's own.
 */
function withInputs<
  TShape extends z.ZodRawShape,
  TOutput extends z.ZodObject<z.ZodRawShape>,
  const TErrors extends readonly ErrorContract[] | undefined,
  const TEnrich extends z.ZodRawShape | undefined,
  TInputs extends Partial<TShape>,
>(
  { name, ...rest }: ToolDefinition<z.ZodObject<TShape>, TOutput, TErrors, TEnrich>,
  inputs: TInputs,
) {
  return tool(name, { ...rest, input: rest.input.extend(inputs) });
}

/** Build the tool list for `createApp({ tools })`. */
export function buildToolDefinitions(options: ToolDefinitionOptions) {
  const { clampLimits, normalizeInputs, rowLimitCap } = options;
  const limit = limitInput(clampLimits);
  return [
    listReferenceTool,
    withInputs(getPopulationTool, { limit }),
    withInputs(getDemographicsTool, { limit, ...demographicLists(normalizeInputs) }),
    withInputs(getAsylumApplicationsTool, { limit, ...applicationLists(normalizeInputs) }),
    withInputs(getAsylumDecisionsTool, { limit, ...decisionLists(normalizeInputs) }),
    withInputs(getSolutionsTool, { limit }),
    dataframeDescribeTool,
    defineDataframeQueryTool({ clamp: clampLimits, rowLimitCap }),
    options.dropEnabled
      ? dataframeDropTool
      : disabledTool(dataframeDropTool, {
          reason:
            'Dropping dataframes is turned off in this deployment; the per-table TTL reclaims staged tables on its own.',
          hint: 'UNHCR_DATAFRAME_DROP_ENABLED=true',
        }),
  ];
}
