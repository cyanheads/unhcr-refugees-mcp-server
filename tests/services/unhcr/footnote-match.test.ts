/**
 * @fileoverview Tests for footnote parsing and local matching over
 * recorded-shape `/footnotes/` rows: year specs (single, range, list), blank
 * country columns, per-row population-type overlap (each row carries its own
 * types, with the folded ones and only the nonzero count columns), the
 * summed-dimension rule, the ranking against the inline cut, and the cap.
 * @module tests/services/unhcr/footnote-match.test
 */

import { describe, expect, it } from 'vitest';
import {
  FOOTNOTE_CAP,
  type Footnote,
  type FootnoteRowKey,
  footnoteSpan,
  matchFootnotes,
  parsePopulationTypes,
  parseYearSpec,
  toFootnote,
  typesWithCounts,
  withFolded,
} from '@/services/unhcr/footnote-match.js';
import { FOOTNOTE_ROWS, MULTILINE_FOOTNOTE_TEXT, type RawRow } from '../../fixtures/unhcr.js';

/** Parsed as the service parses them: notes with no text are dropped. */
const footnotes = FOOTNOTE_ROWS.map(toFootnote).filter((entry) => entry.text !== '');

/** A row key and the footnote types the row carries: REF unless a test says otherwise. */
type TypedRow = FootnoteRowKey & { types: readonly string[] };

const row = (
  year: number,
  origin: string | null,
  asylum: string | null,
  types: readonly string[] = ['REF'],
): TypedRow => ({ year, origin_iso3: origin, asylum_iso3: asylum, types });

const typesOf = (typed: TypedRow) => typed.types;

/** Match against rows in their sorted order, the first `inline` of them shown inline (all, unless a test cuts). */
const match = (parsed: readonly Footnote[], rows: readonly TypedRow[], inline = rows.length) =>
  matchFootnotes(parsed, rows, typesOf, inline);

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

describe('withFolded', () => {
  it('adds the type counted inside a carrier column', () => {
    expect(withFolded('REF')).toEqual(['REF', 'ROC']);
    expect(withFolded('IDP')).toEqual(['IDP', 'IOC']);
  });

  it('returns other types alone, and nothing for a missing type', () => {
    expect(withFolded('STA')).toEqual(['STA']);
    expect(withFolded(null)).toEqual([]);
  });

  it('returns a type named like an Object.prototype member alone', () => {
    for (const code of ['constructor', '__proto__', 'toString']) {
      expect(withFolded(code)).toEqual([code]);
    }
  });
});

describe('typesWithCounts', () => {
  const sorted = (types: readonly string[]) => [...types].sort();

  it('names each population column above zero, with the types folded into it', () => {
    const syrInSyr = {
      year: 2024,
      origin_iso3: 'SYR',
      asylum_iso3: 'SYR',
      refugees: 0,
      asylum_seekers: 0,
      oip: null,
      idps: 7408909,
      stateless: 0,
      ooc: 0,
      hst: 16471143,
      returned_refugees: 0,
      returned_idps: 513896,
    };
    expect(sorted(typesWithCounts(syrInSyr))).toEqual(['HST', 'IDP', 'IOC', 'RDP']);
  });

  it('names solutions columns by their own types, skipping null and zero', () => {
    const syrInDeu = {
      year: 2024,
      origin_iso3: 'SYR',
      asylum_iso3: 'DEU',
      returned_refugees: null,
      resettlement: 2907,
      naturalisation: 0,
      returned_idps: null,
    };
    expect(typesWithCounts(syrInDeu)).toEqual(['RST']);
  });

  it('carries no type for a row whose counts are all null or zero', () => {
    expect(typesWithCounts({ year: 2024, refugees: 0, idps: null, unrwa_refugees: 5 })).toEqual([]);
  });
});

describe('matchFootnotes', () => {
  it('attaches an asylum-named note to rows in that asylum country, whatever the origin', () => {
    const rows = [row(2025, 'SYR', 'DEU'), row(2025, null, 'DEU'), row(2024, 'SYR', 'DEU')];
    const { footnotes: matched, total } = match(footnotes, rows);
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
    const { total } = match(footnotes, [row(2025, 'SYR', null), row(2025, null, null)]);
    expect(total).toBe(0);
  });

  it('requires both named countries to match a pair note', () => {
    const notes = [note({ coo_iso: 'SYR', coa_iso: 'TUR', year: '2017 - 2018' })].map(toFootnote);
    expect(match(notes, [row(2017, 'SYR', 'TUR')]).total).toBe(1);
    expect(match(notes, [row(2017, 'SYR', 'DEU')]).total).toBe(0);
    expect(match(notes, [row(2017, 'SYR', null)]).total).toBe(0);
  });

  it('attaches a note naming no country everywhere its years and types allow', () => {
    const rows = [row(2020, 'SYR', 'DEU'), row(2021, null, null), row(2023, 'AFG', null)];
    const { footnotes: matched } = match(footnotes, rows);
    expect(matched).toEqual([
      expect.objectContaining({ years: '2019 - 2022', origin_iso3: null, rows_matched: 2 }),
    ]);
  });

  it('matches a year inside any range of a year list and not in the gaps', () => {
    const psE = [row(2019, 'PSE', null)];
    expect(match(footnotes, psE).footnotes.map((m) => m.years)).toEqual(['2019 - 2022']);
    const inRange = match(footnotes, [row(2024, 'PSE', 'JOR')]);
    expect(inRange.footnotes.map((m) => m.years)).toEqual(['2015 - 2018, 2020 - 2024']);
  });

  it('skips notes whose population types no row carries', () => {
    const solutions = [
      row(2024, 'SYR', null, ['RET', 'RST', 'NAT', 'RDP']),
      row(2025, 'SYR', null, ['RET', 'RST', 'NAT', 'RDP']),
    ];
    expect(match(footnotes, solutions).footnotes).toEqual([
      expect.objectContaining({ population_types: ['RET', 'RDP'], rows_matched: 2 }),
    ]);
    const stateless = [row(2024, 'SYR', null, ['STA']), row(2025, 'SYR', null, ['STA'])];
    expect(match(footnotes, stateless).total).toBe(0);
  });

  it("counts only the rows at a note's key and year that carry one of its types", () => {
    const notes = [
      note({ footnote: 'IDP note', coo_iso: 'SYR', population_type: 'IDP' }),
      note({ footnote: 'STA note', coo_iso: 'SYR', population_type: 'STA' }),
      note({ footnote: 'Returns note', coo_iso: 'SYR', population_type: 'RET,RDP' }),
    ].map(toFootnote);
    const rows = [
      row(2024, 'SYR', 'DEU', ['REF', 'ROC', 'ASY']),
      row(2024, 'SYR', 'JOR', ['REF', 'ROC', 'RET']),
      row(2024, 'SYR', 'SYR', ['IDP', 'IOC', 'HST', 'RDP']),
      row(2024, 'SYR', 'TUR', ['REF', 'ROC', 'RET']),
    ];
    const { footnotes: matched, total } = match(notes, rows);
    expect(total).toBe(2);
    expect(Object.fromEntries(matched.map((m) => [m.text, m.rows_matched]))).toEqual({
      'IDP note': 1,
      'Returns note': 3,
    });
  });

  it('counts a row once when it carries several of the note’s types', () => {
    const notes = [note({ coa_iso: 'TUR', population_type: 'REF,ASY' })].map(toFootnote);
    const rows = [row(2024, 'SYR', 'TUR', ['REF', 'ROC', 'ASY'])];
    expect(match(notes, rows).footnotes[0]?.rows_matched).toBe(1);
  });

  it('matches a note naming only a folded type through the row’s carrier type', () => {
    const notes = [
      note({ footnote: 'ROC note', coa_iso: 'TUR', population_type: 'ROC' }),
      note({ footnote: 'IOC note', coa_iso: 'TUR', population_type: 'IOC' }),
    ].map(toFootnote);
    const rows = [row(2024, 'SYR', 'TUR', withFolded('REF'))];
    expect(match(notes, rows).footnotes.map((m) => m.text)).toEqual(['ROC note']);
  });

  it('attaches nothing to a row that carries no type', () => {
    const notes = [note({ coa_iso: 'DEU', population_type: 'REF,ASY,IDP,STA' })].map(toFootnote);
    expect(match(notes, [row(2024, 'SYR', 'DEU', [])])).toEqual({
      footnotes: [],
      total: 0,
    });
  });

  describe('ranking against the inline cut', () => {
    // Rows in sorted order; a test cuts them after `inline`.
    const sorted = [
      row(2024, 'SYR', 'DEU'),
      row(2024, 'AFG', 'TUR'),
      row(2024, 'SSD', 'UGA'),
      row(2024, 'SYR', 'POL', ['REF', 'STA']),
      row(2024, 'AFG', 'PAK'),
    ];
    // Notes in UNHCR's order, named for the rows (by position) each matches.
    const notes = [
      note({ footnote: 'POL', coa_iso: 'POL' }),
      note({ footnote: 'general, every row' }),
      note({ footnote: 'TUR first', coa_iso: 'TUR' }),
      note({ footnote: 'UGA', coa_iso: 'UGA' }),
      note({ footnote: 'DEU', coa_iso: 'DEU' }),
      note({ footnote: 'TUR second', coa_iso: 'TUR' }),
      note({ footnote: 'general, POL only', population_type: 'STA' }),
      note({ footnote: 'AFG, TUR and PAK', coo_iso: 'AFG' }),
    ].map(toFootnote);

    it.each([
      [
        'two rows inline: inline-row caveats first, then those of rows past the cut',
        2,
        [
          'DEU',
          'TUR first',
          'TUR second',
          'AFG, TUR and PAK',
          'general, every row',
          'UGA',
          'POL',
          'general, POL only',
        ],
      ],
      [
        'every row inline: one group, by row position',
        5,
        [
          'DEU',
          'TUR first',
          'TUR second',
          'AFG, TUR and PAK',
          'UGA',
          'POL',
          'general, every row',
          'general, POL only',
        ],
      ],
    ])(
      'orders country-specific before general, then by first row matched, then UNHCR order: %s',
      (_label, inline, order) => {
        const result = match(notes, sorted, inline);
        expect(result.footnotes.map((m) => m.text)).toEqual(order);
        expect(result.total).toBe(8);
      },
    );

    it('counts rows_matched over the full result, wherever the cut falls', () => {
      for (const inline of [1, 2, 5]) {
        const counts = Object.fromEntries(
          match(notes, sorted, inline).footnotes.map((m) => [m.text, m.rows_matched]),
        );
        expect(counts).toEqual({
          POL: 1,
          'general, every row': 5,
          'TUR first': 1,
          UGA: 1,
          DEU: 1,
          'TUR second': 1,
          'general, POL only': 1,
          'AFG, TUR and PAK': 2,
        });
      }
    });

    it('ranks a caveat matching an inline row and a row past the cut by its inline row', () => {
      const order = match(notes, sorted, 2).footnotes.map((m) => m.text);
      // AFG matches positions 1 (inline) and 4: it sits with position 1, ahead of UGA at 2.
      expect(order.indexOf('AFG, TUR and PAK')).toBeLessThan(order.indexOf('UGA'));
      expect(order.indexOf('AFG, TUR and PAK')).toBe(order.indexOf('TUR second') + 1);
    });

    it(`keeps every inline-row caveat when more than ${FOOTNOTE_CAP} match only rows past the cut`, () => {
      const pastCut = Array.from({ length: FOOTNOTE_CAP + 5 }, (_, i) =>
        note({ footnote: `TUR ${i}`, coa_iso: 'TUR' }),
      );
      const inlineNotes = ['DEU a', 'DEU b', 'DEU c'].map((text) =>
        note({ footnote: text, coa_iso: 'DEU' }),
      );
      const result = match(
        [...pastCut, ...inlineNotes].map(toFootnote),
        [row(2024, 'SYR', 'DEU'), row(2024, 'SYR', 'TUR')],
        1,
      );
      expect(result.total).toBe(FOOTNOTE_CAP + 8);
      expect(result.footnotes.map((m) => m.text)).toEqual([
        'DEU a',
        'DEU b',
        'DEU c',
        ...Array.from({ length: FOOTNOTE_CAP - 3 }, (_, i) => `TUR ${i}`),
      ]);
    });

    it('takes a caveat’s first row across years, past an earlier-year row its types skip', () => {
      // Sorted by a count, not by year: a 2025 row comes first, carrying only STA.
      const multiYear = [
        row(2025, 'SYR', 'DEU', ['STA']),
        row(2024, 'SYR', 'DEU'),
        row(2025, 'SYR', 'DEU'),
      ];
      const spanning = [
        note({ footnote: 'general, STA', population_type: 'STA', year: '2025' }),
        note({ footnote: 'DEU 2024–2025', coa_iso: 'DEU', year: '2024 - 2025' }),
      ].map(toFootnote);
      // The DEU caveat's first row is position 1 (its 2024 row), inside a cut of 2, so it
      // leads the general caveat; read from its 2025 rows alone it would start past the cut.
      expect(match(spanning, multiYear, 2).footnotes.map((m) => [m.text, m.rows_matched])).toEqual([
        ['DEU 2024–2025', 2],
        ['general, STA', 1],
      ]);
    });

    it(`keeps the caveats of the highest-ranked inline rows when more than ${FOOTNOTE_CAP} match inline rows`, () => {
      const asylums = ['DEU', 'TUR', 'UGA', 'POL', 'PAK'];
      // Listed in reverse row order, so UNHCR's order alone would keep the lowest rows' caveats.
      const byRow = asylums
        .toReversed()
        .flatMap((asylum) =>
          Array.from({ length: 5 }, (_, i) =>
            note({ footnote: `${asylum} ${i}`, coa_iso: asylum }),
          ),
        )
        .map(toFootnote);
      const result = match(
        byRow,
        asylums.map((asylum) => row(2024, 'SYR', asylum)),
        5,
      );
      expect(result.total).toBe(25);
      expect(result.footnotes.map((m) => m.text)).toEqual(
        asylums
          .slice(0, 4)
          .flatMap((asylum) => Array.from({ length: 5 }, (_, i) => `${asylum} ${i}`)),
      );
    });
  });

  it(`caps the list at ${FOOTNOTE_CAP} while total counts every match`, () => {
    const notes = Array.from({ length: FOOTNOTE_CAP + 5 }, (_, i) =>
      note({ footnote: `note ${i}`, coa_iso: 'DEU' }),
    ).map(toFootnote);
    const result = match(notes, [row(2024, null, 'DEU')]);
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
    expect(match(notes, rows).footnotes[0]?.rows_matched).toBe(3);
  });

  it('returns nothing for an empty result', () => {
    expect(match(footnotes, [])).toEqual({ footnotes: [], total: 0 });
  });
});
