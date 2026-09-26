/**
 * @fileoverview Tests for the shared tool helpers: the blank-as-unset and
 * code-list input pieces, markdown escaping for upstream text and caller
 * input, number rendering, the asylum code cells and legend, the sort applied
 * before the inline cut, and attribution.
 * @module tests/tools/shared.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  codeList,
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
import { buildAttribution, sortRows } from '@/mcp-server/tools/shared/results.js';
import { asylumCodeLabel } from '@/services/unhcr/codes.js';
import type { RowIdentity } from '@/services/unhcr/types.js';

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

  it('caps a country filter at 1,000 characters as a string and 100 per listed code', () => {
    const scope = z.object(scopeInputs);
    expect(scope.safeParse({ origin: 'A'.repeat(1_000) }).success).toBe(true);
    expect(scope.safeParse({ origin: 'A'.repeat(1_001) }).success).toBe(false);
    expect(scope.safeParse({ asylum: ['A'.repeat(100)] }).success).toBe(true);
    expect(scope.safeParse({ asylum: ['A'.repeat(101)] }).success).toBe(false);
  });

  it('gives a blank limit or stage its default', () => {
    const paging = z.object(resultInputs);
    expect(paging.parse({ limit: '', stage: '  ' })).toEqual({ limit: 100, stage: false });
    expect(paging.parse({ limit: 7, stage: true })).toEqual({ limit: 7, stage: true });
    expect(paging.safeParse({ limit: 0 }).success).toBe(false);
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
