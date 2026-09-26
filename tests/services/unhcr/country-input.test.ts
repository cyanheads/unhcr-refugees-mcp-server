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
  MAX_COUNTRY_CODES,
  parseCodeList,
  resolveCountryCodes,
} from '@/services/unhcr/country-input.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { initFakeUpstream } from '../../helpers/services.js';

let table: CountryTable;

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

  it('accepts exactly the cap and rejects a string that splits past it, pointing at expand', () => {
    const codes = Array.from(
      { length: MAX_COUNTRY_CODES + 1 },
      (_, i) => `C${String(i).padStart(2, '0')}`,
    );
    expect(parseCodeList(codes.slice(0, MAX_COUNTRY_CODES).join(','), 'asylum')).toHaveLength(
      MAX_COUNTRY_CODES,
    );
    let thrown: unknown;
    try {
      parseCodeList(codes.join(','), 'asylum');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { field: 'asylum', count: MAX_COUNTRY_CODES + 1, max: MAX_COUNTRY_CODES },
    });
    expect((thrown as { data: { recovery: { hint: string } } }).data.recovery.hint).toContain(
      'expand',
    );
  });

  it('counts codes after de-duplication, so repeats never trip the cap', () => {
    const repeated = Array.from({ length: MAX_COUNTRY_CODES + 10 }, () => 'SYR').join(',');
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
    const codes = Array.from(
      { length: MAX_COUNTRY_CODES + 1 },
      (_, i) => `C${String(i).padStart(2, '0')}`,
    );
    expect(parseCodeList(JSON.stringify(codes.slice(1)), 'asylum')).toHaveLength(MAX_COUNTRY_CODES);
    expect(() => parseCodeList(JSON.stringify(codes), 'asylum')).toThrow(
      `asylum lists ${MAX_COUNTRY_CODES + 1} country codes; the limit is ${MAX_COUNTRY_CODES}.`,
    );
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
