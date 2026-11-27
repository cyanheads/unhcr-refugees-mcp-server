/**
 * @fileoverview Input schema pieces shared by the unhcr_get_* data tools. Every
 * optional scalar maps a form client's blank (`""` or whitespace only) to
 * unset before validation, so it takes its default instead of failing an
 * enum, pattern, or range check.
 * @module mcp-server/tools/shared/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createCounter, logger } from '@cyanheads/mcp-ts-core/utils';
import { MAX_COUNTRY_CODES } from '@/services/unhcr/country-input.js';
import { countSchema } from './counts.js';

/** A blank from a form client — empty or whitespace only — is unset, never a value to validate. */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

const scalarInputCounter = createCounter(
  'unhcr.scalar_input.normalized',
  'Scalar string conversions that passed their field schema',
  '{conversion}',
);

/**
 * Accepts canonical scalar spellings behind blank handling without changing the advertised type.
 * Records conversions per parser attempt. A sibling field can still reject the call.
 */
export function scalarInput<T extends z.ZodType>(
  field: 'year_from' | 'year_to' | 'limit' | 'stage' | 'include_nowcast' | 'preview' | 'row_limit',
  schema: T,
  normalize: boolean,
) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (text === '') return;
    if (!normalize) return value;

    let effective: number | boolean;
    if (field === 'stage' || field === 'include_nowcast') {
      if (text !== 'true' && text !== 'false') return value;
      effective = text === 'true';
    } else {
      const number = Number(text);
      if (!Number.isFinite(number) || String(number) !== text) return value;
      effective = number;
    }

    if (schema.safeParse(effective).success) {
      logger.info(`Scalar input normalized: ${field}`);
      scalarInputCounter.add(1, { 'unhcr.scalar_input.field': field });
    }
    return effective;
  }, schema);
}

/** Spells one code as its enum does. */
type Fold = (code: string) => string;

const upperCase: Fold = (code) => code.trim().toUpperCase();
const lowerCase: Fold = (code) => code.trim().toLowerCase();

/** Every string entry folded; any other entry is left for the enum to reject. */
const foldEntries = (entries: readonly unknown[], fold: Fold): unknown[] =>
  entries.map((entry) => (typeof entry === 'string' ? fold(entry) : entry));

/**
 * A list argument as an array of folded codes; a string is split on commas and
 * whitespace. Returns the argument itself when there is nothing to rewrite: an
 * array already in the enum's case, a string naming no code, anything else, or
 * a string opening with `[` — an encoded array, which the framework decodes.
 */
function readCodes(value: unknown, fold: Fold): unknown {
  if (Array.isArray(value)) {
    const folded = foldEntries(value, fold);
    return folded.some((entry, i) => entry !== value[i]) ? folded : value;
  }
  if (typeof value !== 'string' || value.trimStart().startsWith('[')) return value;
  const codes = value.split(/[\s,]+/).filter((code) => code !== '');
  return codes.length > 0 ? codes.map(fold) : value;
}

/** Validated lists a {@link codeArray} rewrote; `finishRows` logs and counts each one. */
const normalizedLists = new WeakSet<object>();

/** Whether a validated input is a list read from a form only normalization accepts. */
export const isNormalizedList = (value: unknown): boolean =>
  Array.isArray(value) && normalizedLists.has(value);

/** An array over a closed code list, one entry per code at most. */
type CodeArray<T extends readonly string[]> = z.ZodArray<z.ZodEnum<{ [K in T[number]]: K }>>;

/**
 * A {@link CodeArray} with `wrap` giving it its unset value. With `normalize`
 * it takes every form {@link readCodes} reads and tags the list that validated.
 * The rewrite runs before validation, and up to three times on a call the
 * framework repairs or rejects, so it tags nothing itself: it notes what it did
 * for the array's own check, which runs on the validated array later in the
 * same synchronous parse. Zod hands a check nothing else from the preprocess in
 * front of it, since an array's output is always a new array.
 */
function codeArray<const T extends readonly [string, ...string[]], S extends z.ZodType>(
  codes: T,
  options: {
    fold: Fold;
    item: string;
    normalize: boolean;
    wrap: (list: CodeArray<T>) => S;
  },
) {
  const { fold, item, normalize, wrap } = options;
  let rewritten = false;
  const list = z
    .array(z.enum(codes).describe(item))
    .max(codes.length)
    .check(({ value }) => {
      if (rewritten) normalizedLists.add(value);
    });
  return z.preprocess((value) => {
    const read = normalize ? readCodes(value, fold) : value;
    rewritten = read !== value;
    return read;
  }, wrap(list));
}

/**
 * An optional filter over a closed code list (asylum stages, decision levels,
 * population types), for one normalize mode. Codes are trimmed and uppercased
 * before the enum check, so matching is case-insensitive; a blank or `[]`
 * means no filter. By default a string reads as the array of the codes in it,
 * and a string naming no code is no filter; with `UNHCR_NORMALIZE_INPUTS=false`
 * the schema rejects any string but a blank.
 */
export const codeList = <const T extends readonly [string, ...string[]]>(
  codes: T,
  item: string,
  normalize: boolean,
) =>
  blankAsUnset(
    z.preprocess(
      (value) => {
        if (Array.isArray(value)) return foldEntries(value, upperCase);
        return normalize && typeof value === 'string' && !/[^\s,]/.test(value) ? undefined : value;
      },
      codeArray(codes, {
        fold: upperCase,
        item,
        normalize,
        wrap: (list) => list.optional(),
      }),
    ),
  );

/**
 * The asylum tools' `split_by` for one normalize mode, with `wrap` adding the
 * tool's default. By default a string reads as the array of the dimensions in
 * it, and case is folded in either form. A string naming no dimension is
 * rejected: it could mean the default, as `""` does, or no split, as `[]` does.
 * With `UNHCR_NORMALIZE_INPUTS=false` the schema takes only arrays in the
 * enum's case.
 */
export const splitByList = <const T extends readonly [string, ...string[]], S extends z.ZodType>(
  dimensions: T,
  normalize: boolean,
  wrap: (list: CodeArray<T>) => S,
) =>
  blankAsUnset(
    codeArray(dimensions, {
      fold: lowerCase,
      item: 'A procedure dimension to keep separate.',
      normalize,
      wrap,
    }),
  );

/**
 * A country filter, as a string or a list. `parseCodeList` counts the cap on
 * distinct codes for both forms; these schema bounds sit above it, so any
 * well-formed list reaches that one check. The string bound fits the cap in the
 * widest accepted spelling, `["ABW", "AFG"]` (7 characters a code); the list
 * bound counts entries before de-duplication.
 */
const countryList = (dimension: string) =>
  blankAsUnset(
    z
      .union([
        z
          .string()
          .max(MAX_COUNTRY_CODES * 7)
          .describe(
            'One code, or several separated by commas or spaces, e.g. "SYR" or "SYR, AFG".',
          ),
        z.array(z.string().max(100)).max(1_000).describe('Codes as a list, e.g. ["SYR", "AFG"].'),
      ])
      .optional(),
  ).describe(dimension);

/** The year window shared by every data tool. */
export const yearInputs = (normalize: boolean) => ({
  year_from: scalarInput(
    'year_from',
    z.number().int().min(1900).max(2100).optional(),
    normalize,
  ).describe(
    "First year of the window. When omitted, the window starts at the dataset's first year. A year before the dataset's first year is clamped to it and the clamp is reported; a window entirely outside the dataset's years is rejected.",
  ),
  year_to: scalarInput(
    'year_to',
    z.number().int().min(1900).max(2100).optional(),
    normalize,
  ).describe(
    'Last year of the window. When omitted, the window runs to the latest published year (latest_year in the result). A year past the latest published year is clamped to it and the clamp is reported.',
  ),
});

/** Country filters, expand, and the year window shared by every data tool. */
export const scopeInputs = {
  origin: countryList(
    `Country of origin — where people fled from — as ISO3 codes (SYR, AFG), case-insensitive. ISO 3166 alpha-2 codes (SY) are rewritten to ISO3 and echoed in applied_scope. UNHCR's own codes (GFR) are rejected with the ISO3 to pass instead, and country names are rejected: resolve a name with unhcr_list_reference (topic countries, name_contains). Each listed code returns its own rows; codes are never summed together. At most ${MAX_COUNTRY_CODES} distinct codes, enough to list every country in UNHCR's country list. Omit to sum every origin into one row, or set expand to list each.`,
  ),
  asylum: countryList(
    `Country of asylum — where people sought or hold protection; for returns, the country they returned from — as ISO3 codes (DEU, TUR), case-insensitive, same rules and limit as origin. Omit to sum every asylum country into one row, or set expand to list each.`,
  ),
  expand: blankAsUnset(z.enum(['none', 'origin', 'asylum', 'both']).default('none')).describe(
    'List every country, one row each, for a dimension that origin or asylum leaves unfiltered: origin, asylum, or both. Default none, where an unfiltered dimension is summed into one row. Expanding a dimension that origin or asylum already filters is rejected.',
  ),
  ...yearInputs(true),
};

/** Most inline rows one data-tool call returns. */
export const LIMIT_CAP = 2_000;

/**
 * The data tools' `limit` for one clamp mode: by default a value above
 * {@link LIMIT_CAP} is served at the cap with a notice (`finishRows` clamps
 * it); with `UNHCR_CLAMP_LIMITS=false` the schema rejects it.
 */
export const limitInput = (clamp: boolean, normalize = true) =>
  scalarInput('limit', countSchema(1, LIMIT_CAP, clamp).default(25), normalize).describe(
    clamp
      ? `Inline rows. Default 25; a larger value returns at most ${LIMIT_CAP} and says so. Sorting runs over the full result first; a larger result is staged as a dataframe where dataframes are enabled.`
      : `Inline rows, 1–${LIMIT_CAP} (default 25). Sorting runs over the full result first; a larger result is staged as a dataframe where dataframes are enabled.`,
  );

/** The staging toggle shared by every data tool. */
export const stageInput = (normalize: boolean) =>
  scalarInput('stage', z.boolean().default(false), normalize).describe(
    'Stage the full result as a dataframe even when it fits inline, e.g. to join it with another unhcr_get_* result in unhcr_dataframe_query. Where dataframes are unavailable it is ignored, and the notice says so.',
  );

/** Paging and staging controls shared by every data tool, in the default clamp mode. */
export const resultInputs = {
  limit: limitInput(true, true),
  stage: stageInput(true),
};
