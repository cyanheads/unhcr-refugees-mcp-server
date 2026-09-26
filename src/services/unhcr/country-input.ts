/**
 * @fileoverview Country input normalization for the `origin` / `asylum`
 * filters. Normalizes what is certain and rejects what is ambiguous: ISO3 in
 * any case is accepted, ISO 3166-1 alpha-2 is rewritten to ISO3 through
 * UNHCR's country table, and UNHCR's own codes and country names are refused
 * with the exact ISO3 to pass instead. UNHCR codes are never normalized because
 * three of them are valid ISO3 codes for other countries (AUS is Austria, ARE
 * is Egypt, MAR is Martinique in UNHCR's scheme).
 * @module services/unhcr/country-input
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { Country } from './types.js';

/** Most codes one `origin` / `asylum` filter may list. */
export const MAX_COUNTRY_CODES = 50;

/** Lookup indexes over UNHCR's country table. */
export interface CountryTable {
  byIso2: ReadonlyMap<string, Country>;
  byIso3: ReadonlyMap<string, Country>;
  byUnhcrCode: ReadonlyMap<string, Country>;
}

/** An ISO2 → ISO3 rewrite, echoed in `applied_scope.normalized`. */
export interface CodeRewrite {
  input: string;
  iso3: string;
}

/** Outcome of validating a list of country codes. */
export type CountryResolution =
  | { ok: true; iso3: string[]; normalized: CodeRewrite[] }
  | {
      ok: false;
      /** Codes with no exact suggestion (names, typos). */
      unresolved: string[];
      /** One sentence per code the server can name an exact ISO3 for. */
      suggestions: string[];
      /** Every rejected input, in order. */
      unknown: string[];
    };

/** Index UNHCR's country table. Entries without an ISO3 code cannot be queried and are skipped. */
export function buildCountryTable(countries: readonly Country[]): CountryTable {
  const byIso3 = new Map<string, Country>();
  const byIso2 = new Map<string, Country>();
  const byUnhcrCode = new Map<string, Country>();
  for (const country of countries) {
    if (!country.iso3) continue;
    byIso3.set(country.iso3, country);
    if (country.iso2) byIso2.set(country.iso2, country);
    byUnhcrCode.set(country.unhcrCode, country);
  }
  return { byIso3, byIso2, byUnhcrCode };
}

/**
 * Split a filter value into trimmed, uppercased, de-duplicated codes. A string
 * splits on commas, whitespace, square brackets, and quotes, none of which a
 * country code contains, so a list a client encoded into a string
 * (`'["DEU","AUT"]'`) yields its codes. Blank entries are ignored, so an empty
 * list means the dimension is unset. A string that splits into more codes than
 * the cap is rejected here, since the array form's cap is enforced by the schema.
 */
export function parseCodeList(value: string | string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  const parts = typeof value === 'string' ? value.split(/[\s,[\]"']+/) : value;
  const codes = [
    ...new Set(parts.map((part) => part.trim().toUpperCase()).filter((part) => part !== '')),
  ];
  if (codes.length > MAX_COUNTRY_CODES) {
    throw validationError(
      `${field} lists ${codes.length} country codes; the limit is ${MAX_COUNTRY_CODES}.`,
      {
        field,
        count: codes.length,
        max: MAX_COUNTRY_CODES,
        recovery: {
          hint: `List at most ${MAX_COUNTRY_CODES} codes in ${field}, or leave ${field} empty and set expand to list every country.`,
        },
      },
    );
  }
  return codes;
}

/** Validate codes against UNHCR's country table, rewriting ISO2 to ISO3. */
export function resolveCountryCodes(
  codes: readonly string[],
  table: CountryTable,
): CountryResolution {
  const iso3: string[] = [];
  const normalized: CodeRewrite[] = [];
  const unknown: string[] = [];
  const unresolved: string[] = [];
  const suggestions: string[] = [];

  for (const code of codes) {
    if (table.byIso3.has(code)) {
      iso3.push(code);
      continue;
    }
    // UNHCR's table gives "Unknown" the alpha-2 code UK, which is not the United Kingdom's.
    if (code === 'UK') {
      unknown.push(code);
      suggestions.push('UK is not an ISO country code; the United Kingdom is GBR.');
      continue;
    }
    const byIso2 = table.byIso2.get(code);
    if (byIso2?.iso3) {
      iso3.push(byIso2.iso3);
      normalized.push({ input: code, iso3: byIso2.iso3 });
      continue;
    }
    unknown.push(code);
    const byUnhcr = table.byUnhcrCode.get(code);
    if (byUnhcr?.iso3) {
      suggestions.push(`${code} is UNHCR's code for ${byUnhcr.name}; pass ${byUnhcr.iso3}.`);
    } else {
      unresolved.push(code);
    }
  }

  if (unknown.length > 0) return { ok: false, unknown, unresolved, suggestions };
  return { ok: true, iso3: [...new Set(iso3)], normalized };
}
