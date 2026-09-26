/**
 * @fileoverview Tests for `buildToolDefinitions` and the Wave 1 definitions'
 * declared surface: the Wave 1 tools are always registered, the drop tool is
 * live only when `UNHCR_DATAFRAME_DROP_ENABLED` is on — otherwise it is
 * wrapped by `disabledTool()` with the setting that turns it on — no other
 * tool's prose routes callers to the off-by-default drop tool, and the
 * annotations match the design. Later tools are not pinned, except for the
 * log severity every tool declares per error reason and the length and size
 * bound every string and array input carries.
 * @module tests/tools/definitions.test
 */

import { disabledTool, z } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';
import { getSolutionsTool } from '@/mcp-server/tools/definitions/get-solutions.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { DATAFRAME_NAME_LENGTH } from '@/services/canvas-bridge/canvas-bridge.js';

/** The JSON Schema keywords the input-bounds walk reads. */
interface SchemaNode {
  anyOf?: SchemaNode[];
  const?: unknown;
  enum?: unknown[];
  items?: SchemaNode;
  maxItems?: number;
  maxLength?: number;
  oneOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  type?: string;
}

/** Paths of the string nodes with no maxLength (enums and constants aside) and array nodes with no maxItems. */
function unboundedNodes(node: SchemaNode, path: string): string[] {
  const unboundedString =
    node.type === 'string' &&
    node.maxLength === undefined &&
    node.enum === undefined &&
    node.const === undefined;
  const unboundedArray = node.type === 'array' && node.maxItems === undefined;
  return [
    ...(unboundedString || unboundedArray ? [path] : []),
    ...Object.entries(node.properties ?? {}).flatMap(([key, child]) =>
      unboundedNodes(child, `${path}.${key}`),
    ),
    ...[...(node.anyOf ?? []), ...(node.oneOf ?? [])].flatMap((child, index) =>
      unboundedNodes(child, `${path}|${index}`),
    ),
    ...(node.items ? unboundedNodes(node.items, `${path}[]`) : []),
  ];
}

const WAVE_1 = [
  listReferenceTool,
  getPopulationTool,
  getSolutionsTool,
  dataframeDescribeTool,
  dataframeQueryTool,
];

describe('buildToolDefinitions', () => {
  it.each([true, false])(
    'registers every Wave 1 data and dataframe tool (drop enabled: %s)',
    (dropEnabled) => {
      const tools = buildToolDefinitions({ dropEnabled });
      for (const tool of WAVE_1) expect(tools).toContain(tool);
      const names = tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it('registers the drop tool live when drop is enabled', () => {
    const tools = buildToolDefinitions({ dropEnabled: true });
    expect(tools.filter((tool) => tool.name === 'unhcr_dataframe_drop')).toEqual([
      dataframeDropTool,
    ]);
    expect(tools).toContain(dataframeDropTool);
  });

  it('wraps the drop tool with disabledTool, naming the setting, when drop is disabled', () => {
    const tools = buildToolDefinitions({ dropEnabled: false });
    const drop = tools.find((tool) => tool.name === 'unhcr_dataframe_drop');
    expect(drop).not.toBe(dataframeDropTool);
    expect(drop).toEqual(
      disabledTool(dataframeDropTool, {
        reason: expect.stringContaining('per-table TTL'),
        hint: 'UNHCR_DATAFRAME_DROP_ENABLED=true',
      }),
    );
  });

  it('keeps every tool name in the unhcr_ namespace', () => {
    for (const tool of buildToolDefinitions({ dropEnabled: true })) {
      expect(tool.name).toMatch(/^unhcr_[a-z_]+$/);
    }
  });
});

describe('Wave 1 declared surface', () => {
  it('never routes callers to the drop tool, which is off by default', () => {
    for (const tool of WAVE_1) {
      const prose = JSON.stringify([
        tool.description,
        tool.errors,
        z.toJSONSchema(tool.input),
        z.toJSONSchema(tool.output),
      ]);
      expect(prose, tool.name).not.toContain('unhcr_dataframe_drop');
    }
  });

  it('declares the annotations the design fixes', () => {
    const openWorldRead = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
    const closedWorldRead = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    expect(listReferenceTool.annotations).toEqual(openWorldRead);
    expect(getPopulationTool.annotations).toEqual(openWorldRead);
    expect(getSolutionsTool.annotations).toEqual(openWorldRead);
    expect(dataframeDescribeTool.annotations).toEqual(closedWorldRead);
    expect(dataframeQueryTool.annotations).toEqual(closedWorldRead);
    // destructiveHint stays at its default (true): dropping discards staged rows.
    expect(dataframeDropTool.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('marks upstream_busy retryable and canvas_unavailable not retryable wherever declared', () => {
    for (const tool of [...WAVE_1, dataframeDropTool]) {
      for (const entry of tool.errors ?? []) {
        if (entry.reason === 'upstream_busy') expect(entry.retryable, tool.name).toBe(true);
        if (entry.reason === 'canvas_unavailable') expect(entry.retryable, tool.name).toBe(false);
      }
    }
  });
});

describe('input bounds', () => {
  it('bounds every string and array input on every tool', () => {
    const unbounded = buildToolDefinitions({ dropEnabled: true }).flatMap((tool) =>
      unboundedNodes(z.toJSONSchema(tool.input, { io: 'input' }) as SchemaNode, tool.name),
    );
    expect(unbounded).toEqual([]);
  });

  it('caps every dataframe name input at the length of a df_XXXXX_XXXXX handle', () => {
    expect('df_ABCDE_12345').toHaveLength(DATAFRAME_NAME_LENGTH);
    const fields = [
      [dataframeDescribeTool, 'name'],
      [dataframeQueryTool, 'register_as'],
      [dataframeDropTool, 'name'],
    ] as const;
    for (const [tool, field] of fields) {
      const schema = z.toJSONSchema(tool.input, { io: 'input' }) as SchemaNode;
      expect(schema.properties?.[field]?.maxLength, tool.name).toBe(DATAFRAME_NAME_LENGTH);
    }
  });
});

describe('error log severity', () => {
  /** Caller mistakes every data tool answers before or instead of fetching data. */
  const SCOPE_MISTAKES = {
    unknown_country_code: 'notice',
    invalid_year_window: 'notice',
    year_out_of_coverage: 'notice',
    conflicting_scope: 'notice',
    upstream_busy: undefined,
  };

  it('logs caller mistakes at notice and dataframes being off at warning; upstream_busy stays at error', () => {
    const severities = Object.fromEntries(
      buildToolDefinitions({ dropEnabled: true }).map((tool) => {
        const entries: readonly ErrorContract[] = tool.errors ?? [];
        return [
          tool.name,
          Object.fromEntries(entries.map((entry) => [entry.reason, entry.severity])),
        ];
      }),
    );
    expect(severities).toStrictEqual({
      unhcr_list_reference: { upstream_busy: undefined },
      unhcr_get_population: SCOPE_MISTAKES,
      unhcr_get_demographics: SCOPE_MISTAKES,
      unhcr_get_asylum_applications: SCOPE_MISTAKES,
      unhcr_get_asylum_decisions: SCOPE_MISTAKES,
      unhcr_get_solutions: SCOPE_MISTAKES,
      unhcr_dataframe_describe: { canvas_unavailable: 'warning', listing_unavailable: 'notice' },
      unhcr_dataframe_query: {
        canvas_unavailable: 'warning',
        missing_table: 'notice',
        invalid_sql: 'notice',
        sql_execution_error: 'notice',
        register_as_clash: 'notice',
        register_as_too_large: 'notice',
        non_select_statement: 'notice',
        multi_statement: 'notice',
        denied_function: 'notice',
        plan_operator_not_allowed: 'notice',
        system_catalog_access: 'notice',
      },
      unhcr_dataframe_drop: { canvas_unavailable: 'warning' },
    });
  });
});
