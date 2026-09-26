/**
 * @fileoverview The tool list handed to `createApp()`. The drop tool stays in
 * the list in every deployment: when `UNHCR_DATAFRAME_DROP_ENABLED` is off it
 * is wrapped with `disabledTool()`, which keeps it out of MCP registration
 * (clients cannot list or call it) while the HTTP landing page still shows it
 * with the setting that turns it on.
 * @module mcp-server/tools/definitions/index
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { getAsylumApplicationsTool } from './get-asylum-applications.tool.js';
import { getAsylumDecisionsTool } from './get-asylum-decisions.tool.js';
import { getDemographicsTool } from './get-demographics.tool.js';
import { getPopulationTool } from './get-population.tool.js';
import { getSolutionsTool } from './get-solutions.tool.js';
import { listReferenceTool } from './list-reference.tool.js';

/** Deployment gates that decide how a tool enters the registration list. */
export interface ToolDefinitionOptions {
  /** `UNHCR_DATAFRAME_DROP_ENABLED`: register `unhcr_dataframe_drop` live instead of disabled. */
  dropEnabled: boolean;
}

/** Build the tool list for `createApp({ tools })`. */
export function buildToolDefinitions(options: ToolDefinitionOptions) {
  return [
    listReferenceTool,
    getPopulationTool,
    getDemographicsTool,
    getAsylumApplicationsTool,
    getAsylumDecisionsTool,
    getSolutionsTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    options.dropEnabled
      ? dataframeDropTool
      : disabledTool(dataframeDropTool, {
          reason:
            'Dropping dataframes is turned off in this deployment; the per-table TTL reclaims staged tables on its own.',
          hint: 'UNHCR_DATAFRAME_DROP_ENABLED=true',
        }),
  ];
}
