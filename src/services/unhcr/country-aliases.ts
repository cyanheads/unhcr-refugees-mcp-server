/**
 * @fileoverview Common English country names UNHCR's list does not carry, each
 * mapped to its ISO3, and the normalizer the keys are written in. A name is
 * here only where matching its words against UNHCR's spellings does not return
 * its country; names more than one country answers to ("congo", "korea"), parts
 * of a country, dissolved states, and territories UNHCR does not list are left
 * out.
 * @module services/unhcr/country-aliases
 */

/** A period between two single characters, as in the initials `u.k.`. */
const INITIAL_PERIOD = /(?<![a-z0-9])([a-z0-9])\.(?=[a-z0-9](?![a-z0-9]))/g;

/**
 * A name as single-spaced lowercase a–z and 0–9 words, accents folded. A period
 * between initials joins them, so `U.K.` reads as one word; any other period,
 * like every other character, is a space (`Dem.Rep.` reads as two words). Text
 * with no Latin letter or digit is `''`. Lowercasing follows the decomposition,
 * which is what yields the capitals in `𝐓` and `№`.
 */
export function normalizeName(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(INITIAL_PERIOD, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * ISO3 by {@link normalizeName}d common name. A name counts only when it is the
 * caller's whole text and its ISO3 is in UNHCR's current list. `uk` is the one
 * key that is also a live code: UNHCR's table gives "Unknown" the alpha-2 code
 * UK, which is not the United Kingdom's.
 */
export const COUNTRY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['caribbean netherlands', 'BES'],
  ['mainland china', 'CHN'],
  ['china mainland', 'CHN'],
  ['prc', 'CHN'],
  ['pr china', 'CHN'],
  ['ivory coast', 'CIV'],
  ['cote divoire', 'CIV'],
  ['drc', 'COD'],
  ['dr congo', 'COD'],
  ['congo dr', 'COD'],
  ['congo kinshasa', 'COD'],
  ['zaire', 'COD'],
  ['congo brazzaville', 'COG'],
  ['czech republic', 'CZE'],
  ['czech rep', 'CZE'],
  ['faroe islands', 'FRO'],
  ['uk', 'GBR'],
  ['guinea conakry', 'GIN'],
  ['republic of ireland', 'IRL'],
  ['st kitts', 'KNA'],
  ['st kitts and nevis', 'KNA'],
  ['st kitts nevis', 'KNA'],
  ['south korea', 'KOR'],
  ['s korea', 'KOR'],
  ['korea south', 'KOR'],
  ['rok', 'KOR'],
  ['laos', 'LAO'],
  ['lao pdr', 'LAO'],
  ['st lucia', 'LCA'],
  ['macau', 'MAC'],
  ['burma', 'MMR'],
  ['myanmar burma', 'MMR'],
  ['burma myanmar', 'MMR'],
  ['holland', 'NLD'],
  ['north korea', 'PRK'],
  ['n korea', 'PRK'],
  ['korea north', 'PRK'],
  ['dprk', 'PRK'],
  ['dpr korea', 'PRK'],
  ['korea dpr', 'PRK'],
  ['palestinian territories', 'PSE'],
  ['occupied palestinian territory', 'PSE'],
  ['occupied palestinian territories', 'PSE'],
  ['west bank and gaza', 'PSE'],
  ['west bank gaza', 'PSE'],
  ['ksa', 'SAU'],
  ['st pierre and miquelon', 'SPM'],
  ['st pierre miquelon', 'SPM'],
  ['saint pierre and miquelon', 'SPM'],
  ['swaziland', 'SWZ'],
  ['east timor', 'TLS'],
  ['turkey', 'TUR'],
  ['republic of turkey', 'TUR'],
  ['turkey turkiye', 'TUR'],
  ['turkiye turkey', 'TUR'],
  ['vatican', 'VAT'],
  ['vatican city', 'VAT'],
  ['vatican city state', 'VAT'],
  ['st vincent', 'VCT'],
  ['st vincent and the grenadines', 'VCT'],
  ['st vincent grenadines', 'VCT'],
  ['st vincent the grenadines', 'VCT'],
]);
