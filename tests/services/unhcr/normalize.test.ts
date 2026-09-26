/**
 * @fileoverview Tests for UNHCR value and identity normalization over
 * recorded-shape rows: integers, the string `"0"`, `"-"`, and trailing spaces.
 * @module tests/services/unhcr/normalize.test
 */

import { describe, expect, it } from 'vitest';
import {
  toCount,
  toDataRow,
  toIdentity,
  toIdentityText,
  toYear,
  type ValueTally,
} from '@/services/unhcr/normalize.js';
import { POPULATION_FIELDS, SOLUTIONS_FIELDS } from '@/services/unhcr/types.js';
import { populationRow, solutionsRow } from '../../fixtures/unhcr.js';

const tally = (): ValueTally => ({ unexpected: 0 });

describe('toCount', () => {
  it('keeps integers and parses numeric strings, "0" included', () => {
    const t = tally();
    expect(toCount(705812, t)).toBe(705812);
    expect(toCount('0', t)).toBe(0);
    expect(toCount(' 42 ', t)).toBe(42);
    expect(toCount('12.5', t)).toBe(12.5);
    expect(t.unexpected).toBe(0);
  });

  it('reads "-" as null (not applicable or not collected) without counting it as unexpected', () => {
    const t = tally();
    expect(toCount('-', t)).toBeNull();
    expect(toCount(' - ', t)).toBeNull();
    expect(t.unexpected).toBe(0);
  });

  it('reads any other value as null and counts it, never as an invented zero', () => {
    const t = tally();
    expect(toCount('n/a', t)).toBeNull();
    expect(toCount('1,234', t)).toBeNull();
    expect(toCount('', t)).toBeNull();
    expect(toCount(Number.NaN, t)).toBeNull();
    expect(toCount(Number.POSITIVE_INFINITY, t)).toBeNull();
    expect(toCount(null, t)).toBeNull();
    expect(toCount(undefined, t)).toBeNull();
    expect(t.unexpected).toBe(7);
  });
});

describe('toYear', () => {
  it('accepts integer years as numbers or strings', () => {
    expect(toYear(2024)).toBe(2024);
    expect(toYear(' 1951 ')).toBe(1951);
  });

  it('rejects non-integer and missing years', () => {
    expect(toYear('2024.5')).toBeUndefined();
    expect(toYear('twenty')).toBeUndefined();
    expect(toYear(undefined)).toBeUndefined();
    expect(toYear(null)).toBeUndefined();
  });
});

describe('toIdentityText', () => {
  it('trims names, including the trailing spaces upstream carries', () => {
    expect(toIdentityText('Curacao ')).toBe('Curacao');
    expect(toIdentityText('Unknown ')).toBe('Unknown');
  });

  it('maps "-" and blanks to null, meaning the dimension is summed', () => {
    expect(toIdentityText('-')).toBeNull();
    expect(toIdentityText(' ')).toBeNull();
    expect(toIdentityText('')).toBeNull();
    expect(toIdentityText(null)).toBeNull();
    expect(toIdentityText({})).toBeNull();
  });

  it('stringifies numeric codes', () => {
    expect(toIdentityText(72)).toBe('72');
  });
});

describe('toIdentity', () => {
  it('reads ISO3, UNHCR code, and name for a named pair', () => {
    const raw = populationRow(2024, 'SYR', 'DEU', [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(toIdentity(raw, 2024)).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: 'DEU',
      asylum_unhcr_code: 'GFR',
      asylum_name: 'Germany',
    });
  });

  it('nulls every identity field of a summed dimension', () => {
    const raw = populationRow(2025, null, null, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(toIdentity(raw, 2025)).toEqual({
      year: 2025,
      origin_iso3: null,
      origin_unhcr_code: null,
      origin_name: null,
      asylum_iso3: null,
      asylum_unhcr_code: null,
      asylum_name: null,
    });
  });
});

describe('toDataRow', () => {
  it('normalizes a recorded population row that mixes integers, "0", and "-"', () => {
    const t = tally();
    const raw = populationRow(2024, 'SYR', 'DEU', [
      725102,
      62959,
      '0',
      '0',
      '0',
      '0',
      '0',
      '-',
      '0',
    ]);
    expect(toDataRow(raw, POPULATION_FIELDS, t)).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: 'DEU',
      asylum_unhcr_code: 'GFR',
      asylum_name: 'Germany',
      refugees: 725102,
      asylum_seekers: 62959,
      oip: null,
      idps: 0,
      stateless: 0,
      ooc: 0,
      hst: 0,
      returned_refugees: 0,
      returned_idps: 0,
    });
    expect(t.unexpected).toBe(0);
  });

  it('reports an omitted upstream field as null, counted, rather than zero', () => {
    const t = tally();
    const { naturalisation: _omitted, ...sparse } = solutionsRow(2024, 'SYR', null, [1, 2, 3, 4]);
    const row = toDataRow(sparse, SOLUTIONS_FIELDS, t);
    expect(row?.naturalisation).toBeNull();
    expect(row?.resettlement).toBe(2);
    expect(t.unexpected).toBe(1);
  });

  it('drops a row with no usable year without counting it as an unexpected value', () => {
    const t = tally();
    const raw = { ...solutionsRow(2024, null, null, [1, 2, 3, 4]), year: 'unknown' };
    expect(toDataRow(raw, SOLUTIONS_FIELDS, t)).toBeUndefined();
    expect(t.unexpected).toBe(0);
  });
});
