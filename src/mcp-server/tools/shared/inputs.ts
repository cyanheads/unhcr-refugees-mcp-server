/**
 * @fileoverview Input schema pieces shared by the unhcr_get_* data tools. Every
 * optional scalar maps a form client's blank (`""` or whitespace only) to
 * unset before validation, so it takes its default instead of failing an
 * enum, pattern, or range check.
 * @module mcp-server/tools/shared/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { MAX_COUNTRY_CODES } from '@/services/unhcr/country-input.js';

/** A blank from a form client — empty or whitespace only — is unset, never a value to validate. */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/**
 * An optional filter over a closed code list (asylum stages, decision levels,
 * population types). Codes are trimmed and uppercased before the enum check,
 * so matching is case-insensitive; a blank or `[]` means no filter.
 */
export const codeList = <const T extends readonly [string, ...string[]]>(codes: T, item: string) =>
  blankAsUnset(
    z.preprocess(
      (value) =>
        Array.isArray(value)
          ? value.map((code) => (typeof code === 'string' ? code.trim().toUpperCase() : code))
          : value,
      z.array(z.enum(codes).describe(item)).max(codes.length).optional(),
    ),
  );

const countryList = (dimension: string) =>
  blankAsUnset(
    z
      .union([
        z
          .string()
          .max(1_000)
          .describe(
            'One code, or several separated by commas or spaces, e.g. "SYR" or "SYR, AFG".',
          ),
        z
          .array(z.string().max(100))
          .max(MAX_COUNTRY_CODES)
          .describe(`Codes as a list, e.g. ["SYR", "AFG"]; at most ${MAX_COUNTRY_CODES}.`),
      ])
      .optional(),
  ).describe(dimension);

/** Country filters, expand, and the year window shared by every data tool. */
export const scopeInputs = {
  origin: countryList(
    `Country of origin — where people fled from — as ISO3 codes (SYR, AFG), case-insensitive. ISO 3166 alpha-2 codes (SY) are rewritten to ISO3 and echoed in applied_scope. UNHCR's own codes (GFR) are rejected with the ISO3 to pass instead, and country names are rejected: resolve a name with unhcr_list_reference (topic countries, name_contains). Each listed code returns its own rows; codes are never summed together. At most ${MAX_COUNTRY_CODES} codes. Omit to sum every origin into one row, or set expand to list each.`,
  ),
  asylum: countryList(
    `Country of asylum — where people sought or hold protection; for returns, the country they returned from — as ISO3 codes (DEU, TUR), case-insensitive, same rules as origin. At most ${MAX_COUNTRY_CODES} codes. Omit to sum every asylum country into one row, or set expand to list each.`,
  ),
  expand: blankAsUnset(z.enum(['none', 'origin', 'asylum', 'both']).default('none')).describe(
    'List every country, one row each, for a dimension that origin or asylum leaves unfiltered: origin, asylum, or both. Default none, where an unfiltered dimension is summed into one row. Expanding a dimension that origin or asylum already filters is rejected.',
  ),
  year_from: blankAsUnset(z.number().int().min(1900).max(2100).optional()).describe(
    "First year of the window. When omitted, the window starts at the dataset's first year. A year before the dataset's first year is clamped to it and the clamp is reported; a window entirely outside the dataset's years is rejected.",
  ),
  year_to: blankAsUnset(z.number().int().min(1900).max(2100).optional()).describe(
    'Last year of the window. When omitted, the window runs to the latest published year (latest_year in the result). A year past the latest published year is clamped to it and the clamp is reported.',
  ),
};

/** Paging and staging controls shared by every data tool. */
export const resultInputs = {
  limit: blankAsUnset(z.number().int().min(1).max(500).default(100)).describe(
    'Rows returned inline, 1–500 (default 100). Sorting runs over the full result first; a larger result is staged as a dataframe where dataframes are enabled.',
  ),
  stage: blankAsUnset(z.boolean().default(false)).describe(
    'Stage the full result as a dataframe even when it fits inline, e.g. to join it with another unhcr_get_* result in unhcr_dataframe_query. Where dataframes are unavailable it is ignored, and the notice says so.',
  ),
};
