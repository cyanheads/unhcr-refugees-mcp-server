/**
 * @fileoverview Tests for the shared tool helpers: the blank-as-unset and
 * code-list input pieces, markdown escaping for upstream text and caller
 * input, number rendering, the asylum code cells and legend, the sort applied
 * before the inline cut, attribution, and the count inputs: their schema in
 * both clamp modes, and the clamp's notice, log line, and counter.
 * @module tests/tools/shared.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampCount, countSchema } from '@/mcp-server/tools/shared/counts.js';
import {
  blankAsUnset,
  codeList,
  LIMIT_CAP,
  limitInput,
  resultInputs,
  scopeInputs,
} from '@/mcp-server/tools/shared/inputs.js';
import {
  blockquote,
  cell,
  count,
  fence,
  inline,
  table,
} from '@/mcp-server/tools/shared/markdown.js';
import {
  codesCell,
  countryCell,
  renderAsylumLegend,
  renderFootnotes,
} from '@/mcp-server/tools/shared/outputs.js';
import { buildAttribution, finishRows, sortRows } from '@/mcp-server/tools/shared/results.js';
import {
  appliedScope,
  type ResolvedDimensions,
  type ResolvedScope,
} from '@/mcp-server/tools/shared/scope.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { asylumCodeLabel } from '@/services/unhcr/codes.js';
import type { RowIdentity } from '@/services/unhcr/types.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { createFailingCanvas, initFakeUpstream } from '../helpers/services.js';

/** Every counter the helpers create; only the count clamp creates one. */
const counter = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => counter,
}));

describe('input helpers', () => {
  const stages = codeList(['N', 'R', 'A'] as const, 'A stage code.');

  it('trims and uppercases each code before the enum check', () => {
    expect(stages.parse([' n', 'a ', 'R'])).toEqual(['N', 'A', 'R']);
  });

  it('treats a missing, blank, or whitespace-only filter as unset, and [] as no filter', () => {
    expect(stages.parse(undefined)).toBeUndefined();
    expect(stages.parse('')).toBeUndefined();
    expect(stages.parse(' \t ')).toBeUndefined();
    expect(stages.parse([])).toEqual([]);
  });

  it('rejects a code outside the list, a non-string entry, and a bare string', () => {
    for (const bad of [['X'], ['N', 'RA'], [1], 'N']) {
      expect(stages.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('caps a code-list filter at one entry per code in its list', () => {
    expect(stages.safeParse(['N', 'R', 'A']).success).toBe(true);
    expect(stages.safeParse(['N', 'R', 'A', 'N']).success).toBe(false);
  });

  it('bounds a country filter at 1,750 characters as a string, 1,000 entries as a list, and 100 per entry', () => {
    const scope = z.object(scopeInputs);
    expect(scope.safeParse({ origin: 'A'.repeat(1_750) }).success).toBe(true);
    expect(scope.safeParse({ origin: 'A'.repeat(1_751) }).success).toBe(false);
    expect(scope.safeParse({ asylum: Array.from({ length: 1_000 }, () => 'SYR') }).success).toBe(
      true,
    );
    expect(scope.safeParse({ asylum: Array.from({ length: 1_001 }, () => 'SYR') }).success).toBe(
      false,
    );
    expect(scope.safeParse({ asylum: ['A'.repeat(100)] }).success).toBe(true);
    expect(scope.safeParse({ asylum: ['A'.repeat(101)] }).success).toBe(false);
  });

  it('fits 250 codes as a string in each accepted spelling, the widest at the 1,750-character bound', () => {
    const scope = z.object(scopeInputs);
    const codes = Array.from({ length: 250 }, (_, i) =>
      [26 * 26, 26, 1]
        .map((place) => String.fromCharCode(65 + (Math.floor(i / place) % 26)))
        .join(''),
    );
    const spellings = [
      codes.join(','),
      codes.join(', '),
      `[${codes.map((code) => `"${code}"`).join(', ')}]`,
    ];
    expect(spellings.at(-1)).toHaveLength(1_750);
    for (const origin of spellings) {
      expect(scope.safeParse({ origin }).success, origin.slice(0, 20)).toBe(true);
    }
  });

  it('gives a blank or omitted limit its default of 25, and a blank stage false', () => {
    const paging = z.object(resultInputs);
    expect(paging.parse({ limit: '', stage: '  ' })).toEqual({ limit: 25, stage: false });
    expect(paging.parse({})).toEqual({ limit: 25, stage: false });
    expect(paging.parse({ limit: 7, stage: true })).toEqual({ limit: 7, stage: true });
  });

  it('keeps an over-cap limit for the clamp, and in strict mode rejects it', () => {
    const clamped = z.object({ limit: limitInput(true) });
    const strict = z.object({ limit: limitInput(false) });
    expect(clamped.parse({ limit: LIMIT_CAP + 1 }).limit).toBe(2_001);
    expect(strict.parse({ limit: LIMIT_CAP }).limit).toBe(2_000);
    expect(strict.safeParse({ limit: LIMIT_CAP + 1 }).success).toBe(false);
    expect(strict.parse({ limit: ' ' }).limit).toBe(25);
  });

  it('states the default and the cap once in the limit description, per mode', () => {
    expect(limitInput(true).description).toContain(
      'Default 25; a larger value returns at most 2000 and says so.',
    );
    expect(limitInput(false).description).toContain('1–2000 (default 25)');
    expect(limitInput(false).description).not.toContain('says so');
  });

  it('lets a default apply to a blank scalar and still validates a real value', () => {
    const sortBy = blankAsUnset(z.enum(['year', 'total']).default('year'));
    expect(sortBy.parse('')).toBe('year');
    expect(sortBy.parse('  ')).toBe('year');
    expect(sortBy.parse('total')).toBe('total');
    expect(sortBy.safeParse('size').success).toBe(false);
    expect(sortBy.safeParse(' total ').success).toBe(false);
  });
});

describe('asylum code rendering', () => {
  const label = (list: 'application_stage' | 'decision_level', code: string) =>
    `${code} ${asylumCodeLabel(list, code)}`;

  it('joins a row’s codes for one table cell, escaping upstream text, with a dash for none', () => {
    expect(codesCell(['FI', 'JR', 'RA'])).toBe('FI, JR, RA');
    expect(codesCell([])).toBe('—');
    expect(codesCell(['A|B\nC'])).toBe('A\\|B C');
  });

  it('decodes each code present once, sorted, per list, skipping lists no row carries', () => {
    const lines = renderAsylumLegend([
      { title: 'Stage', list: 'application_stage', codes: ['R', 'N', 'N', 'NA'] },
      { title: 'Authority', list: 'authority', codes: [] },
      { title: 'Decision level', list: 'decision_level', codes: ['NA'] },
    ]);
    expect(lines).toHaveLength(3);
    const [, stageLine, levelLine] = lines;
    const positions = [
      label('application_stage', 'N'),
      label('application_stage', 'NA'),
      label('application_stage', 'R'),
    ].map((fragment) => stageLine?.indexOf(fragment) ?? -1);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(stageLine?.match(/\bN New\b/g)).toHaveLength(1);
    expect(levelLine).toContain(label('decision_level', 'NA'));
    expect(lines.join('\n')).not.toContain('Authority');
  });

  it('keeps a code no list carries, flattened for its inline slot', () => {
    const [, line] = renderAsylumLegend([
      { title: 'Stage', list: 'application_stage', codes: ['Z\nZ'] },
    ]);
    expect(line).toContain('Z Z');
    expect(line).not.toContain('\n');
  });

  it('renders nothing when no row carries any code', () => {
    const none = renderAsylumLegend([{ title: 'Stage', list: 'application_stage', codes: [] }]);
    expect(none).toEqual([]);
  });
});

describe('markdown helpers', () => {
  it('flattens every line-break form for inline slots', () => {
    expect(inline('a\r\nb\rc\nd')).toBe('a b c d');
  });

  it('treats Unicode and control line separators as line breaks in every helper', () => {
    expect(inline('a\u{2028}b\u{2029}c\u{85}d')).toBe('a b c d');
    expect(inline('a\u{b}b\u{c}c\u{1c}d\u{1d}e\u{1e}f')).toBe('a b c d e f');
    expect(cell('a|b\u{2029}c')).toBe('a\\|b c');
    expect(blockquote('x\u{2028}y')).toBe('> x\n> y');
  });

  it('escapes backslashes and pipes in table cells after flattening', () => {
    expect(cell('a|b\\c\nd')).toBe('a\\|b\\\\c d');
  });

  it('blockquotes every line, including blank ones', () => {
    expect(blockquote('first\r\n\r\nsecond')).toBe('> first\n>\n> second');
    expect(blockquote('> nested quote attempt')).toBe('> > nested quote attempt');
  });

  it('fences with at least three backticks and one more than any run inside', () => {
    expect(fence('plain', 'json')).toBe('```json\nplain\n```');
    expect(fence('has ``` inside', 'json')).toBe('````json\nhas ``` inside\n````');
    expect(fence('has ````` inside')).toBe('``````\nhas ````` inside\n``````');
  });

  it('groups digits and renders null or missing as an em dash, never zero', () => {
    expect(count(6355788)).toBe('6,355,788');
    expect(count(0)).toBe('0');
    expect(count(null)).toBe('—');
    expect(count(undefined)).toBe('—');
  });

  it('renders a header, separator, and rows', () => {
    expect(table(['A', 'B'], [['1', '2']])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('renders a summed dimension as "all (summed)" and a named one with both codes', () => {
    expect(countryCell(null, null, null)).toBe('all (summed)');
    expect(countryCell('DEU', 'GFR', 'Germany')).toBe('Germany [DEU · UNHCR GFR]');
    expect(countryCell('DEU', null, null)).toBe('? [DEU · UNHCR —]');
  });

  it('flattens every upstream field of a footnote’s heading line and blockquotes its text', () => {
    const text = renderFootnotes(
      [
        {
          text: 'Line one\nLine two',
          years: '2024\n2025',
          origin_iso3: 'SY\nR',
          asylum_iso3: 'DE\r\nU',
          population_types: ['REF', 'R\nX'],
          rows_matched: 3,
        },
      ],
      1,
    ).join('\n');
    expect(text).toContain(
      '- **2024 2025** · origin SY R, asylum DE U · types REF, R X · 3 rows matched',
    );
    expect(text).toContain('> Line one\n> Line two');
  });
});

describe('sortRows', () => {
  type Row = RowIdentity & { refugees: number | null };
  const row = (
    year: number,
    origin: string | null,
    asylum: string | null,
    refugees: number | null,
  ): Row => ({
    year,
    origin_iso3: origin,
    origin_unhcr_code: origin,
    origin_name: origin,
    asylum_iso3: asylum,
    asylum_unhcr_code: asylum,
    asylum_name: asylum,
    refugees,
  });
  const rows = [
    row(2025, 'SYR', 'TUR', 10),
    row(2024, 'SYR', 'DEU', null),
    row(2024, null, null, 30),
    row(2024, 'AFG', 'DEU', 30),
    row(2024, 'SYR', 'AUT', 5),
  ];
  const key = (r: Row) => `${r.year}/${r.origin_iso3}/${r.asylum_iso3}`;

  it('orders by year, then origin, then asylum, with summed dimensions first', () => {
    expect(sortRows(rows, 'year').map(key)).toEqual([
      '2024/null/null',
      '2024/AFG/DEU',
      '2024/SYR/AUT',
      '2024/SYR/DEU',
      '2025/SYR/TUR',
    ]);
  });

  it('orders a count field largest first, ties by identity, nulls last', () => {
    expect(sortRows(rows, 'refugees').map(key)).toEqual([
      '2024/null/null',
      '2024/AFG/DEU',
      '2025/SYR/TUR',
      '2024/SYR/AUT',
      '2024/SYR/DEU',
    ]);
  });

  it('leaves the input untouched', () => {
    const before = rows.map(key);
    sortRows(rows, 'refugees');
    expect(rows.map(key)).toEqual(before);
  });

  it('orders rows with no origin, as the nowcast is, by asylum within the year, a count largest first', () => {
    const nowcast = [
      { year: 2026, asylum_iso3: 'TUR', refugees: 5 },
      { year: 2026, asylum_iso3: 'DEU', refugees: null },
      { year: 2026, asylum_iso3: 'JOR', refugees: 5 },
      { year: 2026, asylum_iso3: 'AFG', refugees: 9 },
    ];
    const asylum = (sorted: typeof nowcast) => sorted.map((r) => r.asylum_iso3);
    expect(asylum(sortRows(nowcast, 'year'))).toEqual(['AFG', 'DEU', 'JOR', 'TUR']);
    expect(asylum(sortRows(nowcast, 'refugees'))).toEqual(['AFG', 'JOR', 'TUR', 'DEU']);
  });
});

describe('buildAttribution', () => {
  it('cites UNHCR with the terms URL and de-duplicates and sorts providers', () => {
    expect(buildAttribution(['UNRWA', 'IDMC', 'UNRWA'])).toEqual({
      source: 'UNHCR Refugee Population Statistics Database',
      license: 'CC BY 4.0',
      terms_url:
        'https://www.unhcr.org/what-we-do/data-and-publications/data-and-statistics/terms-use-datasets',
      providers: ['IDMC', 'UNRWA'],
    });
  });
});

describe('count inputs', () => {
  const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });

  beforeEach(() => {
    counter.add.mockClear();
  });

  it('advertises no maximum when clamping, keeping integer and rejecting fractions and values below the minimum', () => {
    const schema = countSchema(1, 2_000, true);
    expect(jsonSchema(schema)).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'integer',
      minimum: 1,
      multipleOf: 1,
    });
    for (const value of [1, 2_000, 2_001, 1e300]) expect(schema.parse(value)).toBe(value);
    for (const value of [0, -1, 1.5, 'many', null, Number.NaN])
      expect(schema.safeParse(value).success, String(value)).toBe(false);
  });

  it('advertises and enforces the cap as a maximum in strict mode', () => {
    const schema = countSchema(0, 1_500, false);
    expect(jsonSchema(schema)).toMatchObject({ type: 'integer', minimum: 0, maximum: 1_500 });
    for (const value of [0, 1_500]) expect(schema.parse(value)).toBe(value);
    for (const value of [-1, 1_501, 1.5]) expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([1, 1_999, 2_000])(
    'passes %s through untouched within the cap: no notice, log line, or counter',
    (requested) => {
      const ctx = createMockContext();
      const clamp = clampCount(ctx, {
        tool: 'unhcr_get_population',
        field: 'limit',
        requested,
        cap: 2_000,
      });
      expect(clamp).toEqual({ effective: requested });
      expect((ctx.log as MockContextLogger).calls).toEqual([]);
      expect(counter.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    [2_001, 'Requested limit 2001; effective limit 2000.'],
    [1e300, 'Requested limit 1e+300; effective limit 2000.'],
  ])(
    'clamps %s to the cap with one notice, one log line, and one counter increment',
    (requested, notice) => {
      const ctx = createMockContext();
      const clamp = clampCount(ctx, {
        tool: 'unhcr_get_population',
        field: 'limit',
        requested,
        cap: 2_000,
      });
      expect(clamp).toEqual({ effective: 2_000, notice });
      expect((ctx.log as MockContextLogger).calls).toEqual([
        {
          level: 'info',
          msg: 'Count input clamped',
          data: { tool: 'unhcr_get_population', field: 'limit', requested, effective: 2_000 },
        },
      ]);
      expect(counter.add).toHaveBeenCalledOnce();
      expect(counter.add).toHaveBeenCalledWith(1, {
        [ATTR_MCP_TOOL_NAME]: 'unhcr_get_population',
        'unhcr.count_input.field': 'limit',
      });
    },
  );
});

describe('finishRows levers at the limit cap', () => {
  type Row = RowIdentity & { refugees: number };
  const dimensions: ResolvedDimensions = {
    origin: { mode: 'summed', codes: [] },
    asylum: { mode: 'each', codes: [] },
    normalized: [],
  };
  const scope: ResolvedScope = {
    ...dimensions,
    applied: appliedScope(dimensions, 2025, 2025),
    clamps: [],
    coverage: { firstYear: 1951, latestYear: 2025 },
    query: { origin: dimensions.origin, asylum: dimensions.asylum, yearFrom: 2025, yearTo: 2025 },
  };
  const rows = (count: number): Row[] =>
    Array.from({ length: count }, (_, i) => ({
      year: 2025,
      origin_iso3: null,
      origin_name: null,
      origin_unhcr_code: null,
      asylum_iso3: `A${String(i).padStart(4, '0')}`,
      asylum_name: null,
      asylum_unhcr_code: null,
      refugees: i,
    }));
  const finish = async (limit: number, count: number) => {
    const ctx = createMockContext();
    const result = await finishRows<Row>(ctx, {
      sourceTool: 'unhcr_get_population',
      datasetLabel: 'population',
      queryParams: {},
      scope,
      rows: rows(count),
      fetchedRows: count,
      complete: true,
      sortBy: 'year',
      limit,
      stage: false,
      countFields: ['refugees'],
      providers: [],
      notices: [],
      yearlessRows: 0,
    });
    return { result, notice: getEnrichment(ctx).notice };
  };

  afterEach(() => {
    initCanvasBridge(undefined);
    disposeUnhcrService();
  });

  describe('without a canvas', () => {
    beforeEach(() => {
      initCanvasBridge(undefined);
    });

    it('offers raise limit below the cap', async () => {
      const { result, notice } = await finish(LIMIT_CAP - 1, LIMIT_CAP + 1);
      expect(result.output.rows).toHaveLength(LIMIT_CAP - 1);
      expect(notice).toBe(
        'Showing 1999 of 2001 rows. Dataframes are unavailable in this deployment, so narrow the filters or year window, or raise limit (max 2000), to see the rest.',
      );
    });

    it.each([
      [LIMIT_CAP, ''],
      [LIMIT_CAP + 1, 'Requested limit 2001; effective limit 2000. '],
    ])('offers only narrowing once limit %s is served at the cap', async (limit, clamp) => {
      const { result, notice } = await finish(limit, LIMIT_CAP + 1);
      expect(result.limit).toBe(LIMIT_CAP);
      expect(result.output.rows).toHaveLength(LIMIT_CAP);
      expect(notice).toBe(
        `${clamp}Showing 2000 of 2001 rows. Dataframes are unavailable in this deployment, so narrow the filters or year window to see the rest.`,
      );
    });
  });

  describe('when staging fails', () => {
    beforeEach(() => {
      initFakeUpstream();
      initCanvasBridge(createFailingCanvas().canvas, { ttlMs: 60_000 });
    });

    it('offers raise limit below the cap', async () => {
      const { notice } = await finish(LIMIT_CAP - 1, LIMIT_CAP + 1);
      expect(notice).toBe(
        'The full set could not be staged as a dataframe; narrow the filters or year window, or raise limit (max 2000), so it fits inline.',
      );
    });

    it('offers only narrowing at the cap', async () => {
      const { notice } = await finish(LIMIT_CAP, LIMIT_CAP + 1);
      expect(notice).toBe(
        'The full set could not be staged as a dataframe; narrow the filters or year window so it fits inline.',
      );
    });
  });
});
