/**
 * @fileoverview Tests for `buildToolDefinitions` and the Wave 1 definitions'
 * declared surface: the Wave 1 tools are always registered, the drop tool is
 * live only when `UNHCR_DATAFRAME_DROP_ENABLED` is on — otherwise it is
 * wrapped by `disabledTool()` with the setting that turns it on — no other
 * tool's prose routes callers to the off-by-default drop tool, and the
 * annotations match the design. Later tools are not pinned, except for the
 * log severity every tool declares per error reason, the length and size
 * bound every string and array input carries, the count inputs' bounds, which
 * `UNHCR_CLAMP_LIMITS` and the canvas row cap set per deployment, and what the
 * list inputs read in each `UNHCR_NORMALIZE_INPUTS` mode — with every other
 * field of a rebuilt data tool left as its module definition.
 * @module tests/tools/definitions.test
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getAsylumApplicationsTool } from '@/mcp-server/tools/definitions/get-asylum-applications.tool.js';
import { getAsylumDecisionsTool } from '@/mcp-server/tools/definitions/get-asylum-decisions.tool.js';
import { getDemographicsTool } from '@/mcp-server/tools/definitions/get-demographics.tool.js';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';
import { getSolutionsTool } from '@/mcp-server/tools/definitions/get-solutions.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { DATAFRAME_NAME_LENGTH } from '@/services/canvas-bridge/canvas-bridge.js';
import { errorOf, structuredOf } from '../helpers/results.js';

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

/** The default deployment: clamping and input normalization on, the canvas's default row cap. */
const DEFAULTS = { clampLimits: true, normalizeInputs: true, rowLimitCap: 10_000 };

describe('buildToolDefinitions', () => {
  it.each([true, false])(
    'registers every Wave 1 data and dataframe tool (drop enabled: %s)',
    (dropEnabled) => {
      const names = buildToolDefinitions({ ...DEFAULTS, dropEnabled }).map((tool) => tool.name);
      for (const tool of WAVE_1) expect(names).toContain(tool.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it('registers the drop tool live when drop is enabled', () => {
    const tools = buildToolDefinitions({ ...DEFAULTS, dropEnabled: true });
    expect(tools.filter((tool) => tool.name === 'unhcr_dataframe_drop')).toEqual([
      dataframeDropTool,
    ]);
    expect(tools).toContain(dataframeDropTool);
  });

  it('wraps the drop tool with disabledTool, naming the setting, when drop is disabled', () => {
    const tools = buildToolDefinitions({ ...DEFAULTS, dropEnabled: false });
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
    for (const tool of buildToolDefinitions({ ...DEFAULTS, dropEnabled: true })) {
      expect(tool.name).toMatch(/^unhcr_[a-z_]+$/);
    }
  });
});

describe('count inputs', () => {
  /** Each tool's count inputs as `tools/list` advertises them. */
  const countSchemas = (options: { clampLimits: boolean; rowLimitCap: number }) =>
    Object.fromEntries(
      buildToolDefinitions({ ...DEFAULTS, ...options, dropEnabled: false }).flatMap((tool) => {
        const { properties = {} } = z.toJSONSchema(tool.input, { io: 'input' }) as {
          properties?: Record<string, Record<string, unknown>>;
        };
        return ['limit', 'preview', 'row_limit']
          .filter((field) => field in properties)
          .map((field) => [`${tool.name}.${field}`, properties[field]]);
      }),
    );

  const DATA_TOOLS = [
    'unhcr_get_population',
    'unhcr_get_demographics',
    'unhcr_get_asylum_applications',
    'unhcr_get_asylum_decisions',
    'unhcr_get_solutions',
  ];

  it('advertises integers with no maximum by default, at the default canvas row cap', () => {
    const schemas = countSchemas(DEFAULTS);
    expect(Object.keys(schemas).sort()).toEqual(
      [
        ...DATA_TOOLS.map((tool) => `${tool}.limit`),
        'unhcr_dataframe_query.preview',
        'unhcr_dataframe_query.row_limit',
      ].sort(),
    );
    for (const [field, schema] of Object.entries(schemas)) {
      expect(schema, field).toMatchObject({ type: 'integer' });
      expect(schema, field).not.toHaveProperty('maximum');
    }
    for (const tool of DATA_TOOLS) expect(schemas[`${tool}.limit`]).toMatchObject({ default: 25 });
    expect(schemas['unhcr_dataframe_query.row_limit']).toMatchObject({ default: 1000 });
  });

  it('advertises a maximum at each cap with UNHCR_CLAMP_LIMITS=false', () => {
    const schemas = countSchemas({ clampLimits: false, rowLimitCap: 10_000 });
    for (const tool of DATA_TOOLS)
      expect(schemas[`${tool}.limit`]).toMatchObject({ type: 'integer', maximum: 2_000 });
    expect(schemas['unhcr_dataframe_query.preview']).toMatchObject({ maximum: 1_500 });
    expect(schemas['unhcr_dataframe_query.row_limit']).toMatchObject({ maximum: 10_000 });
  });

  it('follows a canvas row cap below the default: row_limit defaults to it, and strict mode caps there', () => {
    expect(
      countSchemas({ clampLimits: true, rowLimitCap: 500 })['unhcr_dataframe_query.row_limit'],
    ).toMatchObject({ default: 500 });
    expect(
      countSchemas({ clampLimits: false, rowLimitCap: 500 })['unhcr_dataframe_query.row_limit'],
    ).toMatchObject({ default: 500, maximum: 500 });
  });

  it('rejects an over-cap limit at the schema only in strict mode', () => {
    const population = (clampLimits: boolean) =>
      buildToolDefinitions({ ...DEFAULTS, clampLimits, dropEnabled: false }).find(
        (tool) => tool.name === 'unhcr_get_population',
      );
    expect(population(true)?.input.safeParse({ limit: 2_001 }).success).toBe(true);
    expect(population(false)?.input.safeParse({ limit: 2_001 }).success).toBe(false);
    expect(population(false)?.input.safeParse({ limit: 2_000 }).success).toBe(true);
  });

  it.each([
    [true, true],
    [false, true],
    [true, false],
  ])(
    'registers each data tool as its own definition, advertising only another limit (clamping %s, normalizing %s)',
    (clampLimits, normalizeInputs) => {
      const registered = buildToolDefinitions({
        clampLimits,
        normalizeInputs,
        rowLimitCap: 10_000,
        dropEnabled: false,
      });
      /** The advertised input schema, limit aside. */
      const withoutLimit = (input: z.ZodType) => {
        const { properties, ...rest } = z.toJSONSchema(input, { io: 'input' }) as {
          properties: Record<string, unknown>;
        };
        const { limit: _limit, ...fields } = properties;
        return { ...rest, properties: fields };
      };
      // The tool tests exercise these module definitions; createApp() serves the rebuilt ones.
      for (const original of [
        getPopulationTool,
        getDemographicsTool,
        getAsylumApplicationsTool,
        getAsylumDecisionsTool,
        getSolutionsTool,
      ]) {
        const rebuilt = registered.find((tool) => tool.name === original.name);
        const { input: rebuiltInput, ...rebuiltRest } = rebuilt!;
        const { input: originalInput, ...originalRest } = original;
        expect(rebuiltRest, original.name).toEqual(originalRest);
        expect(withoutLimit(rebuiltInput), original.name).toEqual(withoutLimit(originalInput));
      }
    },
  );
});

describe('list inputs', () => {
  const APPLICATIONS = 'unhcr_get_asylum_applications';
  const DECISIONS = 'unhcr_get_asylum_decisions';
  const DEMOGRAPHICS = 'unhcr_get_demographics';

  /**
   * What a deployment's registered tool makes of one list argument, through the
   * argument parse a client's call takes: the parsed list, null when it is
   * unset, or the rejection.
   */
  const read = async (
    toolName: string,
    field: string,
    value: unknown,
    normalizeInputs: boolean,
  ): Promise<readonly string[] | string | null> => {
    const definition = buildToolDefinitions({
      ...DEFAULTS,
      normalizeInputs,
      dropEnabled: false,
    }).find(({ name }) => name === toolName);
    const probe = tool(toolName, {
      description: 'Echoes one parsed list input.',
      input: definition!.input as z.ZodObject<z.ZodRawShape>,
      output: z.object({
        parsed: z.array(z.string()).nullable().describe('The parsed list, null when unset.'),
      }),
      handler: (input) => ({ parsed: (input[field] as string[] | undefined) ?? null }),
    });
    const result = await runToolContract(probe, { [field]: value });
    return result.isError
      ? errorOf(result).message
      : (structuredOf(result).parsed as string[] | null);
  };

  /** The rejection of one list input, as a client reads it. */
  const rejected = (toolName: string, issue: string) =>
    `Input validation error: Invalid arguments for tool ${toolName}: ${issue}`;

  const ALL_STAGES = 'N,R,A,NA,NR,FA,J,BL,SP,V,RA';
  const stageIssue = (issue: string) => rejected(APPLICATIONS, issue);
  const stageList = stageIssue('stages: Invalid input: expected array, received string');
  const unknownStage = (index: number) =>
    stageIssue(
      `stages.${index}: Invalid option: expected one of "N"|"R"|"A"|"NA"|"NR"|"FA"|"J"|"BL"|"SP"|"V"|"RA"`,
    );
  const tooManyStages = stageIssue('stages: Too big: expected array to have <=11 items');

  /** A `stages` argument, what it reads as by default, and what it reads as with normalization off. */
  const STAGE_INPUTS: [value: unknown, normalized: unknown, strict: unknown][] = [
    // A string reads as the array of the codes in it.
    ['N', ['N'], stageList],
    ['n', ['N'], stageList],
    [' N ', ['N'], stageList],
    ['N,R', ['N', 'R'], stageList],
    ['N, R', ['N', 'R'], stageList],
    ['N R', ['N', 'R'], stageList],
    ['N\nr\tna', ['N', 'R', 'NA'], stageList],
    ['N,', ['N'], stageList],
    [',N,,R ,', ['N', 'R'], stageList],
    ['N,N', ['N', 'N'], stageList],
    ['N R', ['N', 'R'], stageList],
    [ALL_STAGES, ALL_STAGES.split(','), stageList],
    // No code at all is no filter.
    [',', null, stageList],
    [' , ,', null, stageList],
    // One bad code rejects the string at that code's index, as in an array.
    ['ZZ', unknownStage(0), stageList],
    ['N,ZZ', unknownStage(1), stageList],
    ['N;R', unknownStage(0), stageList],
    ['N|R', unknownStage(0), stageList],
    ["'N'", unknownStage(0), stageList],
    ['"N"', unknownStage(0), stageList],
    ['{"a":"N"}', unknownStage(0), stageList],
    [`${ALL_STAGES},N`, tooManyStages, stageList],
    // An encoded array is the framework's to decode.
    ['["N"]', ['N'], ['N']],
    ['["N","R"]', ['N', 'R'], ['N', 'R']],
    ['["n"]', ['N'], ['N']],
    [' ["N"]', ['N'], ['N']],
    ['[]', [], []],
    ['[ ]', [], []],
    ['[N]', stageList, stageList],
    ['["N,R"]', stageList, stageList],
    ['[""]', stageList, stageList],
    // Blanks, null, and arrays.
    ['', null, null],
    ['  ', null, null],
    [null, null, null],
    [[], [], []],
    [['n'], ['N'], ['N']],
    [[' N '], ['N'], ['N']],
    [
      ['N', 'N'],
      ['N', 'N'],
      ['N', 'N'],
    ],
    [['N', 'ZZ'], unknownStage(1), unknownStage(1)],
    [['N,R'], unknownStage(0), unknownStage(0)],
    [['N', ''], unknownStage(1), unknownStage(1)],
    [['N', 5], unknownStage(1), unknownStage(1)],
    [[...ALL_STAGES.split(','), 'N'], tooManyStages, tooManyStages],
    // Anything else keeps the array's own message.
    ...[
      [5, 'number'],
      [true, 'boolean'],
      [{}, 'object'],
    ].map(([value, type]): [unknown, unknown, unknown] => {
      const issue = stageIssue(`stages: Invalid input: expected array, received ${type}`);
      return [value, issue, issue];
    }),
  ];

  it.each(STAGE_INPUTS)('reads a code filter of %j', async (value, normalized, strict) => {
    expect(await read(APPLICATIONS, 'stages', value, true), 'normalizing').toEqual(normalized);
    expect(await read(APPLICATIONS, 'stages', value, false), 'strict').toEqual(strict);
  });

  const splitIssue = (issue: string) => rejected(APPLICATIONS, issue);
  const splitList = splitIssue('split_by: Invalid input: expected array, received string');
  const unknownSplit = splitIssue(
    'split_by.0: Invalid option: expected one of "authority"|"stage"|"decision_level"',
  );
  const tooManySplits = splitIssue('split_by: Too big: expected array to have <=3 items');

  /** A `split_by` argument (default `["stage"]`), by default and with normalization off. */
  const SPLIT_INPUTS: [value: unknown, normalized: unknown, strict: unknown][] = [
    // A string or an array reads in any case.
    ['stage', ['stage'], splitList],
    ['Stage', ['stage'], splitList],
    [' authority ', ['authority'], splitList],
    ['Decision_Level, STAGE', ['decision_level', 'stage'], splitList],
    ['stage authority', ['stage', 'authority'], splitList],
    ['stage,', ['stage'], splitList],
    ['stage,stage', ['stage', 'stage'], splitList],
    ['authority,stage,decision_level', ['authority', 'stage', 'decision_level'], splitList],
    [['Stage'], ['stage'], unknownSplit],
    [[' authority '], ['authority'], unknownSplit],
    ['["Stage"]', ['stage'], splitList],
    // "" is the default and "[]" no split, so a string naming no dimension is neither.
    ['', ['stage'], ['stage']],
    ['  ', ['stage'], ['stage']],
    [null, ['stage'], ['stage']],
    ['[]', [], []],
    ['[ ]', [], []],
    [[], [], []],
    [',', splitList, splitList],
    [' , ,', splitList, splitList],
    // An array already in the enum's case.
    [
      ['authority', 'authority'],
      ['authority', 'authority'],
      ['authority', 'authority'],
    ],
    [
      '["authority","decision_level"]',
      ['authority', 'decision_level'],
      ['authority', 'decision_level'],
    ],
    // Nothing outside the enum.
    ['none', unknownSplit, splitList],
    ['unit', unknownSplit, splitList],
    ['authority;stage', unknownSplit, splitList],
    [['unit'], unknownSplit, unknownSplit],
    ['[authority]', splitList, splitList],
    ['authority,stage,decision_level,stage', tooManySplits, splitList],
    [['stage', 'stage', 'stage', 'stage'], tooManySplits, tooManySplits],
    ...[
      [5, 'number'],
      [true, 'boolean'],
      [{}, 'object'],
    ].map(([value, type]): [unknown, unknown, unknown] => {
      const issue = splitIssue(`split_by: Invalid input: expected array, received ${type}`);
      return [value, issue, issue];
    }),
  ];

  it.each(SPLIT_INPUTS)('reads a split of %j', async (value, normalized, strict) => {
    expect(await read(APPLICATIONS, 'split_by', value, true), 'normalizing').toEqual(normalized);
    expect(await read(APPLICATIONS, 'split_by', value, false), 'strict').toEqual(strict);
  });

  it.each([
    [DECISIONS, 'decision_levels', 'fi, ra', ['FI', 'RA']],
    [DECISIONS, 'split_by', 'Authority', ['authority']],
    [DEMOGRAPHICS, 'population_types', 'ref asy', ['REF', 'ASY']],
  ])('rebuilds %s.%s for each mode', async (toolName, field, value, parsed) => {
    expect(await read(toolName, field, value, true)).toEqual(parsed);
    expect(await read(toolName, field, value, false)).toBe(
      rejected(toolName, `${field}: Invalid input: expected array, received string`),
    );
  });

  it('gives a blank or "[]" decisions split no dimension, its default', async () => {
    for (const value of ['', '[]', []]) {
      expect(await read(DECISIONS, 'split_by', value, true)).toEqual([]);
    }
  });

  /** Each tool's list inputs as `tools/list` advertises them, description aside. */
  const listSchemas = (normalizeInputs: boolean) =>
    Object.fromEntries(
      buildToolDefinitions({ ...DEFAULTS, normalizeInputs, dropEnabled: false }).flatMap((tool) => {
        const { properties = {} } = z.toJSONSchema(tool.input, { io: 'input' }) as {
          properties?: Record<string, { description?: string }>;
        };
        return ['split_by', 'stages', 'decision_levels', 'population_types']
          .filter((field) => field in properties)
          .map((field) => {
            const { description: _description, ...schema } = properties[field]!;
            return [`${tool.name}.${field}`, schema];
          });
      }),
    );

  it.each([true, false])(
    'advertises every list as an array of its codes alone (normalizing %s)',
    (normalizeInputs) => {
      const dimension = 'A procedure dimension to keep separate.';
      expect(listSchemas(normalizeInputs)).toStrictEqual({
        [`${APPLICATIONS}.split_by`]: {
          default: ['stage'],
          maxItems: 3,
          type: 'array',
          items: {
            type: 'string',
            enum: ['authority', 'stage', 'decision_level'],
            description: dimension,
          },
        },
        [`${APPLICATIONS}.stages`]: {
          maxItems: 11,
          type: 'array',
          items: {
            type: 'string',
            enum: ['N', 'R', 'A', 'NA', 'NR', 'FA', 'J', 'BL', 'SP', 'V', 'RA'],
            description: 'An application-stage code.',
          },
        },
        [`${DECISIONS}.split_by`]: {
          default: [],
          maxItems: 2,
          type: 'array',
          items: {
            type: 'string',
            enum: ['authority', 'decision_level'],
            description: dimension,
          },
        },
        [`${DECISIONS}.decision_levels`]: {
          maxItems: 14,
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'NA',
              'FI',
              'AR',
              'RA',
              'IN',
              'EO',
              'JR',
              'SP',
              'FA',
              'TP',
              'TA',
              'BL',
              'TR',
              'CA',
            ],
            description: 'A decision-level code.',
          },
        },
        [`${DEMOGRAPHICS}.population_types`]: {
          maxItems: 9,
          type: 'array',
          items: {
            type: 'string',
            enum: ['REF', 'ASY', 'OIP', 'IDP', 'STA', 'OOC', 'HST', 'RET', 'RDP'],
            description: 'A population-type code.',
          },
        },
      });
    },
  );

  it('advertises byte-identical input schemas with normalization on and off', () => {
    const schemas = (normalizeInputs: boolean) =>
      buildToolDefinitions({ ...DEFAULTS, normalizeInputs, dropEnabled: true }).map((tool) =>
        JSON.stringify(z.toJSONSchema(tool.input, { io: 'input' })),
      );
    expect(schemas(false)).toEqual(schemas(true));
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
    const unbounded = buildToolDefinitions({ ...DEFAULTS, dropEnabled: true }).flatMap((tool) =>
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
    too_many_country_codes: 'notice',
    upstream_busy: undefined,
  };

  it('logs caller mistakes at notice and dataframes being off at warning; upstream_busy stays at error', () => {
    const severities = Object.fromEntries(
      buildToolDefinitions({ ...DEFAULTS, dropEnabled: true }).map((tool) => {
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
