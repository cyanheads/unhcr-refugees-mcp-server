/**
 * @fileoverview Scope resolution for the unhcr_get_* data tools: country
 * codes, expand, and the year window, validated in the order the design fixes.
 * Checks that need no upstream data run first (reversed window, expand
 * conflicts, the code cap), then codes are checked against the cached country
 * table, and only then is the dataset's coverage probed to fill, clamp, or
 * reject the window — so a caller mistake the server can detect never surfaces
 * as an upstream failure. Failures come back as values carrying a declared
 * contract reason, which the handler raises through `ctx.fail`.
 * @module mcp-server/tools/shared/scope
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ProbedDataset } from '@/services/unhcr/codes.js';
import {
  type CodeRewrite,
  type CountryResolution,
  parseCodeList,
  resolveCountryCodes,
} from '@/services/unhcr/country-input.js';
import type { Coverage, DatasetQuery, DimensionScope } from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { type AppliedScope, yearSpan } from './outputs.js';

export type Expand = 'asylum' | 'both' | 'none' | 'origin';

/** The scope inputs every data tool shares. */
export interface ScopeInput {
  asylum?: string | string[] | undefined;
  expand: Expand;
  origin?: string | string[] | undefined;
  year_from?: number | undefined;
  year_to?: number | undefined;
}

/** Validated country dimensions, before any year window is applied. */
export interface ResolvedDimensions {
  asylum: DimensionScope;
  normalized: CodeRewrite[];
  origin: DimensionScope;
}

/** A fully resolved scope, ready to send upstream. */
export interface ResolvedScope extends ResolvedDimensions {
  applied: AppliedScope;
  /** Disclosures for bounds clamped to coverage. */
  clamps: string[];
  coverage: Coverage;
  query: DatasetQuery;
}

/**
 * A scope the caller must fix, carrying the declared reason to fail with.
 * `hint`, when present, is a dynamic recovery that overrides the contract's.
 */
export type ScopeFailure =
  | {
      reason: 'conflicting_scope' | 'invalid_year_window' | 'unknown_country_code';
      message: string;
      data: Record<string, unknown>;
      hint?: string;
    }
  | {
      reason: 'year_out_of_coverage';
      message: string;
      data: Record<string, unknown>;
      hint: string;
      coverage: Coverage;
      dimensions: ResolvedDimensions;
      /** The requested window with missing bounds filled from coverage. */
      window: { year_from: number; year_to: number };
    };

export type ScopeOutcome =
  | { ok: true; scope: ResolvedScope }
  | { ok: false; failure: ScopeFailure };

/** Human label per probed dataset, for messages. */
const DATASET_LABEL: Record<ProbedDataset, string> = {
  population: 'Population',
  demographics: 'Demographics',
  'asylum-applications': 'Asylum-application',
  'asylum-decisions': 'Asylum-decision',
  solutions: 'Solutions',
  unrwa: 'UNRWA',
  idmc: 'IDMC',
};

const dimension = (codes: string[], expanded: boolean): DimensionScope => {
  if (codes.length > 0) return { mode: 'listed', codes };
  return { mode: expanded ? 'each' : 'summed', codes: [] };
};

/** Compose the unknown-code failure across both dimensions. */
function unknownCodes(
  failed: { field: string; resolution: Extract<CountryResolution, { ok: false }> }[],
): ScopeFailure {
  const unknown = failed.flatMap(({ resolution }) => resolution.unknown);
  const suggestions = failed.flatMap(({ resolution }) => resolution.suggestions);
  const unresolved = failed.flatMap(({ resolution }) => resolution.unresolved);
  const listing = failed.map(
    ({ field, resolution }) => `${field} ${resolution.unknown.join(', ')}`,
  );
  const failure: ScopeFailure = {
    reason: 'unknown_country_code',
    message: `Not an ISO3 code in UNHCR's country list: ${listing.join('; ')}.`,
    data: { codes: unknown },
  };
  if (suggestions.length === 0) return failure;
  const routing =
    unresolved.length > 0
      ? [
          `For ${unresolved.join(', ')}, find the country with unhcr_list_reference (topic countries, name_contains) and pass its ISO3 code.`,
        ]
      : [];
  return { ...failure, hint: [...suggestions, ...routing].join(' ') };
}

/** Resolve and validate the shared scope inputs for one dataset. */
export async function resolveScope(
  input: ScopeInput,
  dataset: ProbedDataset,
  ctx: Context,
): Promise<ScopeOutcome> {
  const originCodes = parseCodeList(input.origin, 'origin');
  const asylumCodes = parseCodeList(input.asylum, 'asylum');

  if (
    input.year_from !== undefined &&
    input.year_to !== undefined &&
    input.year_from > input.year_to
  ) {
    return {
      ok: false,
      failure: {
        reason: 'invalid_year_window',
        message: `year_from ${input.year_from} is later than year_to ${input.year_to}.`,
        data: { year_from: input.year_from, year_to: input.year_to },
      },
    };
  }

  const expandOrigin = input.expand === 'origin' || input.expand === 'both';
  const expandAsylum = input.expand === 'asylum' || input.expand === 'both';
  const conflicts = [
    ...(expandOrigin && originCodes.length > 0 ? ['origin'] : []),
    ...(expandAsylum && asylumCodes.length > 0 ? ['asylum'] : []),
  ];
  if (conflicts.length > 0) {
    return {
      ok: false,
      failure: {
        reason: 'conflicting_scope',
        message: `expand=${input.expand} lists every country for ${conflicts.join(' and ')}, which the ${conflicts.join(' and ')} codes already filter.`,
        data: { expand: input.expand, conflicts },
      },
    };
  }

  const service = getUnhcrService();
  const normalized: CodeRewrite[] = [];
  const resolved = { origin: originCodes, asylum: asylumCodes };
  if (originCodes.length > 0 || asylumCodes.length > 0) {
    const { table } = await service.countries(ctx);
    const failed: Parameters<typeof unknownCodes>[0] = [];
    for (const field of ['origin', 'asylum'] as const) {
      if (resolved[field].length === 0) continue;
      const resolution = resolveCountryCodes(resolved[field], table);
      if (!resolution.ok) {
        failed.push({ field, resolution });
        continue;
      }
      resolved[field] = resolution.iso3;
      normalized.push(...resolution.normalized);
    }
    if (failed.length > 0) return { ok: false, failure: unknownCodes(failed) };
  }

  const dimensions: ResolvedDimensions = {
    origin: dimension(resolved.origin, expandOrigin),
    asylum: dimension(resolved.asylum, expandAsylum),
    normalized,
  };

  const coverage = await service.coverage(dataset, ctx);
  const span = yearSpan(coverage.firstYear, coverage.latestYear);
  const requestedFrom = input.year_from ?? coverage.firstYear;
  const requestedTo = input.year_to ?? Math.max(coverage.latestYear, requestedFrom);
  if (requestedFrom > coverage.latestYear || requestedTo < coverage.firstYear) {
    const requested =
      input.year_to === undefined
        ? `${requestedFrom} onward`
        : input.year_from === undefined
          ? `through ${requestedTo}`
          : yearSpan(requestedFrom, requestedTo);
    return {
      ok: false,
      failure: {
        reason: 'year_out_of_coverage',
        message: `${DATASET_LABEL[dataset]} data covers ${span}; the requested window (${requested}) lies outside it.`,
        data: { coverage: { first_year: coverage.firstYear, latest_year: coverage.latestYear } },
        hint: `${DATASET_LABEL[dataset]} data covers ${span}; request years inside that span (unhcr_list_reference, topic coverage, lists every dataset's span).`,
        coverage,
        dimensions,
        window: { year_from: requestedFrom, year_to: requestedTo },
      },
    };
  }

  const yearFrom = Math.max(requestedFrom, coverage.firstYear);
  const yearTo = Math.min(requestedTo, coverage.latestYear);
  const clamps = [
    ...(input.year_from !== undefined && input.year_from < coverage.firstYear
      ? [
          `year_from ${input.year_from} precedes the data (${span}), so the window starts at ${yearFrom}.`,
        ]
      : []),
    ...(input.year_to !== undefined && input.year_to > coverage.latestYear
      ? [
          `year_to ${input.year_to} is past the latest published year, so the window ends at ${yearTo}.`,
        ]
      : []),
  ];

  return {
    ok: true,
    scope: {
      ...dimensions,
      coverage,
      clamps,
      query: { origin: dimensions.origin, asylum: dimensions.asylum, yearFrom, yearTo },
      applied: appliedScope(dimensions, yearFrom, yearTo),
    },
  };
}

/** The `applied_scope` output for resolved dimensions and a window. */
export function appliedScope(
  dimensions: ResolvedDimensions,
  yearFrom: number,
  yearTo: number,
): AppliedScope {
  return {
    origin: { mode: dimensions.origin.mode, codes: dimensions.origin.codes },
    asylum: { mode: dimensions.asylum.mode, codes: dimensions.asylum.codes },
    year_from: yearFrom,
    year_to: yearTo,
    normalized: dimensions.normalized,
  };
}
