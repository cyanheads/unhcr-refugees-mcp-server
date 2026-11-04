/**
 * @fileoverview Tests for country input normalization against a country
 * table built from recorded `/countries/` rows: ISO3 in any case, ISO2
 * rewritten to ISO3, UNHCR codes and names refused with the exact ISO3, and
 * UNHCR's "UK" (Unknown) never read as the United Kingdom.
 * @module tests/services/unhcr/country-input.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildCountryTable,
  type CountryTable,
  parseCodeList,
  resolveCountryCodes,
} from '@/services/unhcr/country-input.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { initFakeUpstream } from '../../helpers/services.js';

let table: CountryTable;

/** The value `run` throws, failing the test when it returns instead. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw');
}

beforeAll(async () => {
  // The table is built exactly as production builds it: from recorded /countries/ rows.
  const { service } = initFakeUpstream();
  ({ table } = await service.countries(createMockContext()));
  disposeUnhcrService();
});

describe('buildCountryTable', () => {
  it('indexes by ISO3, ISO2, and UNHCR code, skipping rows with no ISO3', () => {
    expect(table.byIso3.get('DEU')?.unhcrCode).toBe('GFR');
    expect(table.byIso2.get('DE')?.iso3).toBe('DEU');
    expect(table.byUnhcrCode.get('GFR')?.iso3).toBe('DEU');
    expect(table.byUnhcrCode.has('CRB')).toBe(false);
    expect(table.byUnhcrCode.has('SGS')).toBe(false);
    expect([...table.byIso3.keys()]).not.toContain(null);
  });

  it('skips a country without an ISO3 even when it has other codes', () => {
    const built = buildCountryTable([
      {
        unhcrCode: 'XYZ',
        iso3: null,
        iso2: 'XY',
        name: 'Nowhere',
        nameLong: null,
        nameShort: null,
        nameFormal: null,
        nameOrigin: null,
        nationality: null,
        majorArea: null,
        unsdRegion: null,
      },
    ]);
    expect(built.byIso2.size).toBe(0);
    expect(built.byUnhcrCode.size).toBe(0);
  });
});

describe('parseCodeList', () => {
  it('splits a string on commas and whitespace, uppercases, trims, and de-duplicates', () => {
    expect(parseCodeList('syr, afg  deu,SYR', 'origin')).toEqual(['SYR', 'AFG', 'DEU']);
  });

  it('accepts the array form with the same normalization', () => {
    expect(parseCodeList([' syr', 'AFG', 'syr'], 'origin')).toEqual(['SYR', 'AFG']);
  });

  it('treats blank entries and an empty list as unset', () => {
    expect(parseCodeList(undefined, 'origin')).toEqual([]);
    expect(parseCodeList('', 'origin')).toEqual([]);
    expect(parseCodeList(' , ,', 'origin')).toEqual([]);
    expect(parseCodeList([], 'origin')).toEqual([]);
    expect(parseCodeList(['', '  '], 'origin')).toEqual([]);
  });

  it('accepts 250 distinct codes and fails 251 with too_many_country_codes, alike as a string and a list', () => {
    const codes = Array.from({ length: 251 }, (_, i) => `C${String(i).padStart(3, '0')}`);
    expect(parseCodeList(codes.slice(0, 250).join(','), 'asylum')).toHaveLength(250);
    expect(parseCodeList(codes.slice(0, 250), 'asylum')).toHaveLength(250);
    for (const value of [codes.join(','), codes.join(', '), codes]) {
      expect(thrownBy(() => parseCodeList(value, 'asylum'))).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'asylum lists 251 distinct country codes; the limit is 250.',
        data: {
          reason: 'too_many_country_codes',
          field: 'asylum',
          count: 251,
          max: 250,
          recovery: {
            hint: 'List at most 250 distinct codes in asylum, or leave asylum empty and set expand to list every country.',
          },
        },
      });
    }
  });

  it('counts codes after de-duplication in both forms, so repeats never trip the cap', () => {
    const repeated = Array.from({ length: 251 }, () => 'syr');
    expect(parseCodeList(repeated.join(','), 'origin')).toEqual(['SYR']);
    expect(parseCodeList(repeated, 'origin')).toEqual(['SYR']);
  });

  it('splits on brackets and quotes too, so a list encoded into a string yields its codes', () => {
    expect(parseCodeList('["DEU","AUT"]', 'asylum')).toEqual(['DEU', 'AUT']);
    expect(parseCodeList('[ "syr" ]', 'origin')).toEqual(['SYR']);
    expect(parseCodeList("['syr', 'afg']", 'origin')).toEqual(['SYR', 'AFG']);
    expect(parseCodeList('[SYR, AFG]', 'origin')).toEqual(['SYR', 'AFG']);
    expect(parseCodeList('[]', 'origin')).toEqual([]);
    expect(parseCodeList('["", " "]', 'origin')).toEqual([]);
  });

  it('applies the cap to a list encoded into a string', () => {
    const codes = Array.from({ length: 251 }, (_, i) => `C${String(i).padStart(3, '0')}`);
    expect(parseCodeList(JSON.stringify(codes.slice(1)), 'asylum')).toHaveLength(250);
    expect(() => parseCodeList(JSON.stringify(codes), 'asylum')).toThrow(
      'asylum lists 251 distinct country codes; the limit is 250.',
    );
  });
});

/**
 * The split runs over caller text, so its CPU cost is held linear against the
 * shapes that break a scanner: a long separator run, an opener repeated with
 * no closer, many tiny tokens, one unbroken token, and many distinct codes for
 * the de-duplication set. Thread CPU time, the least of several runs per size,
 * doubling from 5k to 320k characters; at every step the cost may grow at most
 * 4× faster than the input, so the full 64× span stays under 256×.
 */
describe('parseCodeList CPU cost', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];

  /** The four-letter code numbered `n`, base 26 (AAAA, AAAB, …). */
  const codeAt = (n: number) =>
    Array.from({ length: 4 }, (_, i) =>
      String.fromCharCode(65 + (Math.floor(n / 26 ** (3 - i)) % 26)),
    ).join('');

  /** Least thread CPU time, in µs, of seven parses of `input`. */
  function cpuMicros(input: string): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 7; run++) {
      const start = process.threadCpuUsage();
      try {
        parseCodeList(input, 'origin');
      } catch {
        // Past the cap: the split and de-duplication have already run.
      }
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, user + system);
    }
    return least;
  }

  it.each([
    ['a separator run', (size: number) => ' ,["\''.repeat(size / 5)],
    ['an opener repeated with no closer', (size: number) => `${'['.repeat(size - 3)}SYR`],
    ['many tiny tokens', (size: number) => 'SY, '.repeat(size / 4)],
    ['one unbroken token', (size: number) => 'A'.repeat(size)],
    [
      'many distinct codes',
      (size: number) =>
        Array.from({ length: size / 5 }, (_, i) => codeAt(i))
          .join(',')
          .padEnd(size, ','),
    ],
  ])('splits %s in linear time from 5k to 320k characters', (_shape, build) => {
    const base = cpuMicros(build(SIZES[0] as number));
    for (const size of SIZES.slice(1)) {
      const growth = (size / (SIZES[0] as number)) * 4;
      expect(cpuMicros(build(size)) / base, `${size} characters`).toBeLessThan(growth);
    }
  });
});

describe('resolveCountryCodes', () => {
  it('accepts ISO3 codes, including UNHCR non-country codes XXA, UNK, and TIB', () => {
    expect(resolveCountryCodes(['SYR', 'XXA', 'UNK', 'TIB'], table)).toEqual({
      ok: true,
      iso3: ['SYR', 'XXA', 'UNK', 'TIB'],
      normalized: [],
    });
  });

  it('reads a colliding code as ISO3: AUS is Australia, not UNHCR’s Austria', () => {
    const result = resolveCountryCodes(['AUS', 'MAR'], table);
    expect(result).toEqual({ ok: true, iso3: ['AUS', 'MAR'], normalized: [] });
    expect(table.byIso3.get('AUS')?.name).toBe('Australia');
    expect(table.byIso3.get('MAR')?.name).toBe('Morocco');
  });

  it('rewrites ISO2 to ISO3 and echoes each rewrite', () => {
    expect(resolveCountryCodes(['DE', 'SY'], table)).toEqual({
      ok: true,
      iso3: ['DEU', 'SYR'],
      normalized: [
        { input: 'DE', iso3: 'DEU' },
        { input: 'SY', iso3: 'SYR' },
      ],
    });
  });

  it('de-duplicates an ISO2 and its ISO3 given together', () => {
    const result = resolveCountryCodes(['SY', 'SYR'], table);
    expect(result).toEqual({ ok: true, iso3: ['SYR'], normalized: [{ input: 'SY', iso3: 'SYR' }] });
  });

  it('refuses UK, UNHCR’s alpha-2 for Unknown, and names GBR for the United Kingdom', () => {
    expect(resolveCountryCodes(['UK'], table)).toEqual({
      ok: false,
      unknown: ['UK'],
      unresolved: [],
      suggestions: ['UK is not an ISO country code; the United Kingdom is GBR.'],
    });
  });

  it('refuses a UNHCR-only code with the exact ISO3 to pass instead', () => {
    expect(resolveCountryCodes(['GFR', 'LEB'], table)).toEqual({
      ok: false,
      unknown: ['GFR', 'LEB'],
      unresolved: [],
      suggestions: [
        "GFR is UNHCR's code for Germany; pass DEU.",
        "LEB is UNHCR's code for Lebanon; pass LBN.",
      ],
    });
  });

  it('refuses names and unknown codes without a suggestion', () => {
    expect(resolveCountryCodes(['SYRIA', 'ZZZ'], table)).toEqual({
      ok: false,
      unknown: ['SYRIA', 'ZZZ'],
      unresolved: ['SYRIA', 'ZZZ'],
      suggestions: [],
    });
  });

  it('fails the whole list when any code is rejected', () => {
    const result = resolveCountryCodes(['SYR', 'DE', 'GFR'], table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unknown).toEqual(['GFR']);
  });
});
