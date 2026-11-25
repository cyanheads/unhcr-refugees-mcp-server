/**
 * @fileoverview Tests for the common-name table and the normalizer its keys
 * are written in: the table against a literal copy, every key as its own
 * normalized form, and the characters the normalizer drops, spaces, and folds.
 * @module tests/services/unhcr/country-aliases.test
 */

import { describe, expect, it } from 'vitest';
import { COUNTRY_ALIASES, normalizeName } from '@/services/unhcr/country-aliases.js';

/** Every alias per ISO3. */
const EXPECTED: Record<string, string[]> = {
  BES: ['caribbean netherlands'],
  CHN: ['mainland china', 'china mainland', 'prc', 'pr china'],
  CIV: ['ivory coast', 'cote divoire'],
  COD: ['drc', 'dr congo', 'congo dr', 'congo kinshasa', 'zaire'],
  COG: ['congo brazzaville'],
  CZE: ['czech republic', 'czech rep'],
  FRO: ['faroe islands'],
  GBR: ['uk'],
  GIN: ['guinea conakry'],
  IRL: ['republic of ireland'],
  KNA: ['st kitts', 'st kitts and nevis', 'st kitts nevis'],
  KOR: ['south korea', 's korea', 'korea south', 'rok'],
  LAO: ['laos', 'lao pdr'],
  LCA: ['st lucia'],
  MAC: ['macau'],
  MMR: ['burma', 'myanmar burma', 'burma myanmar'],
  NLD: ['holland'],
  PRK: ['north korea', 'n korea', 'korea north', 'dprk', 'dpr korea', 'korea dpr'],
  PSE: [
    'palestinian territories',
    'occupied palestinian territory',
    'occupied palestinian territories',
    'west bank and gaza',
    'west bank gaza',
  ],
  SAU: ['ksa'],
  SPM: ['st pierre and miquelon', 'st pierre miquelon', 'saint pierre and miquelon'],
  SWZ: ['swaziland'],
  TLS: ['east timor'],
  TUR: ['turkey', 'republic of turkey', 'turkey turkiye', 'turkiye turkey'],
  VAT: ['vatican', 'vatican city', 'vatican city state'],
  VCT: [
    'st vincent',
    'st vincent and the grenadines',
    'st vincent grenadines',
    'st vincent the grenadines',
  ],
};

describe('COUNTRY_ALIASES', () => {
  it('holds exactly 62 aliases for 26 countries', () => {
    const byIso3: Record<string, string[]> = {};
    for (const [alias, iso3] of COUNTRY_ALIASES) {
      byIso3[iso3] = [...(byIso3[iso3] ?? []), alias].sort();
    }
    expect(byIso3).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED).map(([iso3, aliases]) => [iso3, aliases.toSorted()]),
      ),
    );
    expect(COUNTRY_ALIASES.size).toBe(62);
    expect(Object.keys(byIso3)).toHaveLength(26);
  });

  it.each([...COUNTRY_ALIASES.keys()])('keys %j in its own normalized form', (alias) => {
    expect(normalizeName(alias)).toBe(alias);
  });

  it('leaves out ambiguous names, parts of a country, and names the token match already returns', () => {
    for (const name of [
      'congo',
      'korea',
      'st martin',
      'england',
      'gaza',
      'taiwan',
      'us',
      'sudan',
    ]) {
      expect(COUNTRY_ALIASES.has(name), name).toBe(false);
    }
  });

  it('shortens to two letters only for uk, so no other alias can read as an ISO2 code', () => {
    expect([...COUNTRY_ALIASES.keys()].filter((alias) => alias.length < 3)).toEqual(['uk']);
  });

  it('never answers for an object-prototype key or an empty name', () => {
    for (const name of ['constructor', '__proto__', 'proto', 'toString', 'hasOwnProperty', '']) {
      expect(COUNTRY_ALIASES.get(name), name).toBeUndefined();
    }
  });
});

describe('normalizeName', () => {
  it.each([
    ['Türkiye', 'turkiye'],
    ['TURKEY', 'turkey'],
    [' Turkey!\n', 'turkey'],
    ["Côte d'Ivoire", 'cote d ivoire'],
    ['Viet-Nam', 'viet nam'],
    ['Korea,  South', 'korea south'],
    ['Congo (Kinshasa)', 'congo kinshasa'],
    ['Ｕ．Ｋ．', 'uk'],
    ['Nº 1', 'no 1'],
    // Characters that are capitals, or hold one, only once decomposed.
    ['𝐓urkey', 'turkey'],
    ['№ 1', 'no 1'],
    ['İran', 'iran'],
  ])('lowercases, folds accents, and spaces punctuation in %j', (text, expected) => {
    expect(normalizeName(text)).toBe(expected);
  });

  it.each([
    ['U.K.', 'uk'],
    ['U.S.A', 'usa'],
    ['D.P.R.K.', 'dprk'],
    ['D.R.Congo', 'dr congo'],
    // The accent is gone before the initials join.
    ['Ú.K.', 'uk'],
    // A word's last letter is not an initial.
    ['Congo.D.R.', 'congo dr'],
    ['S. Korea', 's korea'],
    ['S.Korea', 's korea'],
    ['St.Lucia', 'st lucia'],
    ['Dem. Rep. of the Congo', 'dem rep of the congo'],
    ['Dem.Rep. of the Congo', 'dem rep of the congo'],
    ['Iran (Islamic Rep.of)', 'iran islamic rep of'],
    ['.', ''],
  ])('joins initials and spaces every other period in %j', (text, expected) => {
    expect(normalizeName(text)).toBe(expected);
  });

  it.each(['', '   ', '!!!', 'Россия', '日本', '̖́'])(
    'leaves nothing of %j, which holds no Latin letter or digit',
    (text) => {
      expect(normalizeName(text)).toBe('');
    },
  );

  it('reads a letter under any run of combining marks as that letter', () => {
    expect(normalizeName(`t̖́ͅurkeý̴`)).toBe('turkey');
  });
});
