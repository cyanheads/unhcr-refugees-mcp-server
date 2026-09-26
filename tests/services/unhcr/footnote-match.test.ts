/**
 * @fileoverview Tests for footnote parsing and local matching over
 * recorded-shape `/footnotes/` rows: year specs (single, range, list), blank
 * country columns, population-type overlap, the summed-dimension rule, the
 * country-specific-first order, and the cap.
 * @module tests/services/unhcr/footnote-match.test
 */

import { describe, expect, it } from 'vitest';
import {
  FOOTNOTE_CAP,
  type FootnoteRowKey,
  footnoteSpan,
  matchFootnotes,
  parsePopulationTypes,
  parseYearSpec,
  toFootnote,
} from '@/services/unhcr/footnote-match.js';
import { FOOTNOTE_ROWS, MULTILINE_FOOTNOTE_TEXT, type RawRow } from '../../fixtures/unhcr.js';

/** Parsed as the service parses them: notes with no text are dropped. */
const footnotes = FOOTNOTE_ROWS.map(toFootnote).filter((entry) => entry.text !== '');

const row = (year: number, origin: string | null, asylum: string | null): FootnoteRowKey => ({
  year,
  origin_iso3: origin,
  asylum_iso3: asylum,
});

const note = (spec: Partial<RawRow>): RawRow => ({
  footnote: 'A caveat.',
  year: '2024',
  coo: ' ',
  coa: ' ',
  coo_id: 278,
  coa_id: 278,
  coo_iso: '',
  coa_iso: '',
  population_type: 'REF',
  ...spec,
});

describe('parseYearSpec', () => {
  it('parses a single year, a range, and a mixed list', () => {
    expect(parseYearSpec('2015')).toEqual([[2015, 2015]]);
    expect(parseYearSpec('2019 - 2022')).toEqual([[2019, 2022]]);
    expect(parseYearSpec('2021, 2023 - 2025')).toEqual([
      [2021, 2021],
      [2023, 2025],
    ]);
    expect(parseYearSpec('2015 - 2019, 2021, 2024')).toEqual([
      [2015, 2019],
      [2021, 2021],
      [2024, 2024],
    ]);
  });

  it('accepts an en dash and a reversed range', () => {
    expect(parseYearSpec('2019–2022')).toEqual([[2019, 2022]]);
    expect(parseYearSpec('2022 - 2019')).toEqual([[2019, 2022]]);
  });

  it('drops segments it cannot parse', () => {
    expect(parseYearSpec('')).toEqual([]);
    expect(parseYearSpec('various, 2020')).toEqual([[2020, 2020]]);
  });
});

describe('parsePopulationTypes', () => {
  it('splits, trims, and uppercases the comma list', () => {
    expect(parsePopulationTypes('REF, asy ,')).toEqual(['REF', 'ASY']);
    expect(parsePopulationTypes('')).toEqual([]);
  });
});

describe('toFootnote', () => {
  it('reads a country-specific note by its ISO columns, never its display names', () => {
    expect(toFootnote(FOOTNOTE_ROWS[2] as RawRow)).toEqual({
      text: 'Refugee figure for Syrians in Turkey is a Government estimate.',
      years: '2017 - 2018',
      ranges: [[2017, 2018]],
      originIso3: 'SYR',
      asylumIso3: 'TUR',
      populationTypes: ['REF'],
    });
  });

  it('reads blank country columns (" " name, "" ISO) as naming no country', () => {
    const parsed = toFootnote(FOOTNOTE_ROWS[5] as RawRow);
    expect(parsed.originIso3).toBeNull();
    expect(parsed.asylumIso3).toBeNull();
    expect(parsed.populationTypes).toHaveLength(13);
  });

  it('keeps multi-line text verbatim apart from surrounding whitespace', () => {
    const parsed = footnotes.find((entry) => entry.years === '2023');
    expect(parsed?.text).toBe(MULTILINE_FOOTNOTE_TEXT);
  });

  it('tolerates a numeric year and missing columns', () => {
    const parsed = toFootnote({ footnote: ' Text ', year: 2020 });
    expect(parsed).toEqual({
      text: 'Text',
      years: '2020',
      ranges: [[2020, 2020]],
      originIso3: null,
      asylumIso3: null,
      populationTypes: [],
    });
  });
});

describe('footnoteSpan', () => {
  it('spans the earliest and latest year any footnote covers', () => {
    expect(footnoteSpan(footnotes)).toEqual([2015, 2025]);
  });

  it('is undefined for an empty set', () => {
    expect(footnoteSpan([])).toBeUndefined();
  });
});

describe('matchFootnotes', () => {
  const populationTypes = [
    'REF',
    'ROC',
    'ASY',
    'OIP',
    'IDP',
    'IOC',
    'STA',
    'OOC',
    'HST',
    'RET',
    'RDP',
  ];

  it('attaches an asylum-named note to rows in that asylum country, whatever the origin', () => {
    const rows = [row(2025, 'SYR', 'DEU'), row(2025, null, 'DEU'), row(2024, 'SYR', 'DEU')];
    const { footnotes: matched, total } = matchFootnotes(footnotes, rows, ['REF']);
    expect(total).toBe(1);
    expect(matched).toEqual([
      {
        text: expect.stringContaining('refugees from Ukraine in Germany'),
        years: '2025',
        origin_iso3: null,
        asylum_iso3: 'DEU',
        population_types: ['REF'],
        rows_matched: 2,
      },
    ]);
  });

  it('never attaches a country-named note to a row where that dimension is summed', () => {
    const { total } = matchFootnotes(
      footnotes,
      [row(2025, 'SYR', null), row(2025, null, null)],
      ['REF'],
    );
    expect(total).toBe(0);
  });

  it('requires both named countries to match a pair note', () => {
    const notes = [note({ coo_iso: 'SYR', coa_iso: 'TUR', year: '2017 - 2018' })].map(toFootnote);
    expect(matchFootnotes(notes, [row(2017, 'SYR', 'TUR')], ['REF']).total).toBe(1);
    expect(matchFootnotes(notes, [row(2017, 'SYR', 'DEU')], ['REF']).total).toBe(0);
    expect(matchFootnotes(notes, [row(2017, 'SYR', null)], ['REF']).total).toBe(0);
  });

  it('attaches a note naming no country everywhere its years and types allow', () => {
    const rows = [row(2020, 'SYR', 'DEU'), row(2021, null, null), row(2023, 'AFG', null)];
    const { footnotes: matched } = matchFootnotes(footnotes, rows, populationTypes);
    expect(matched).toEqual([
      expect.objectContaining({ years: '2019 - 2022', origin_iso3: null, rows_matched: 2 }),
    ]);
  });

  it('matches a year inside any range of a year list and not in the gaps', () => {
    const psE = [row(2019, 'PSE', null)];
    expect(matchFootnotes(footnotes, psE, ['REF']).footnotes.map((m) => m.years)).toEqual([
      '2019 - 2022',
    ]);
    const inRange = matchFootnotes(footnotes, [row(2024, 'PSE', 'JOR')], ['REF']);
    expect(inRange.footnotes.map((m) => m.years)).toEqual(['2015 - 2018, 2020 - 2024']);
  });

  it("skips notes whose population types do not overlap the tool's", () => {
    const rows = [row(2024, 'SYR', null), row(2025, 'SYR', null)];
    const solutions = matchFootnotes(footnotes, rows, ['RET', 'RST', 'NAT', 'RDP']);
    expect(solutions.footnotes.map((m) => m.population_types)).toEqual([['RET', 'RDP']]);
    expect(matchFootnotes(footnotes, rows, ['STA']).total).toBe(0);
  });

  it('lists country-specific notes before general ones, each group in upstream order', () => {
    const notes = [
      note({ footnote: 'general A', year: '2024' }),
      note({ footnote: 'specific B', coa_iso: 'DEU', year: '2024' }),
      note({ footnote: 'general C', year: '2024' }),
      note({ footnote: 'specific D', coo_iso: 'SYR', year: '2024' }),
    ].map(toFootnote);
    const { footnotes: matched } = matchFootnotes(notes, [row(2024, 'SYR', 'DEU')], ['REF']);
    expect(matched.map((m) => m.text)).toEqual([
      'specific B',
      'specific D',
      'general A',
      'general C',
    ]);
  });

  it(`caps the list at ${FOOTNOTE_CAP} while total counts every match`, () => {
    const notes = Array.from({ length: FOOTNOTE_CAP + 5 }, (_, i) =>
      note({ footnote: `note ${i}`, coa_iso: 'DEU' }),
    ).map(toFootnote);
    const result = matchFootnotes(notes, [row(2024, null, 'DEU')], ['REF']);
    expect(result.footnotes).toHaveLength(FOOTNOTE_CAP);
    expect(result.total).toBe(FOOTNOTE_CAP + 5);
    expect(result.footnotes[0]?.text).toBe('note 0');
  });

  it('counts matched rows per note across years', () => {
    const notes = [note({ coo_iso: 'SYR', year: '2023 - 2024' })].map(toFootnote);
    const rows = [
      row(2023, 'SYR', 'DEU'),
      row(2023, 'SYR', 'JOR'),
      row(2024, 'SYR', null),
      row(2025, 'SYR', null),
    ];
    expect(matchFootnotes(notes, rows, ['REF']).footnotes[0]?.rows_matched).toBe(3);
  });

  it('returns nothing for an empty result', () => {
    expect(matchFootnotes(footnotes, [], populationTypes)).toEqual({ footnotes: [], total: 0 });
  });
});
