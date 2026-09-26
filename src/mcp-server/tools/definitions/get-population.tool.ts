/**
 * @fileoverview unhcr_get_population — year-end displacement stocks by origin
 * and/or asylum country (1951 to the latest year), with UNRWA's Palestine
 * refugees and IDMC's conflict-IDP estimate joined beside each row as separate
 * series, matched UNHCR footnotes, and an optional current-year nowcast.
 * @module mcp-server/tools/definitions/get-population
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { POPULATION_FOOTNOTE_TYPES, type Provider } from '@/services/unhcr/codes.js';
import { matchFootnotes } from '@/services/unhcr/footnote-match.js';
import {
  type CompanionRow,
  type NowcastResult,
  type NowcastRow,
  POPULATION_FIELDS,
  type PopulationRow,
} from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { blankAsUnset, resultInputs, scopeInputs } from '../shared/inputs.js';
import { cell, count, table } from '../shared/markdown.js';
import {
  countField,
  countryCell,
  dataEnrichment,
  footnoteSchema,
  identityCells,
  identityFields,
  renderFootnotes,
  renderNotesAndAttribution,
  renderResultHeader,
  sharedResultFields,
} from '../shared/outputs.js';
import { buildAttribution, finishRows } from '../shared/results.js';
import { appliedScope, resolveScope } from '../shared/scope.js';

/** A population row with the companion series joined beside it. */
type JoinedRow = PopulationRow & {
  idmc_conflict_idps?: number | null;
  unrwa_refugees?: number | null;
};

const rowKey = (row: { asylum_iso3: string | null; origin_iso3: string | null; year: number }) =>
  `${row.year}|${row.origin_iso3 ?? ''}|${row.asylum_iso3 ?? ''}`;

/** Join a companion series onto population rows by (year, origin, asylum); never summed in. */
function companionIndex(rows: readonly CompanionRow[]): Map<string, number | null> {
  return new Map(rows.map((row) => [rowKey(row), row.total]));
}

const STOCK_NOTES = [
  'Counts are year-end stocks: people in each situation on 31 December. returned_refugees and returned_idps are flows — returns during the calendar year, the same series unhcr_get_solutions reports — recorded against the country returned from and against the origin country itself, respectively.',
  'refugees includes people in refugee-like situations; idps counts conflict IDPs UNHCR protects or assists, including people in IDP-like situations.',
  'Rows for the same country as origin and asylum carry IDPs, host communities, and IDP returns.',
  'Values below 5 are rounded to the nearest multiple of 5, so small counts are approximate.',
  'null means UNHCR marks the category not applicable or not collected (oip, for example, before the category existed); it is never zero.',
];

/** When a nowcast row is dated: "August 2026", or the year alone when UNHCR sent no month. */
const snapshotLabel = (row: NowcastRow): string =>
  row.month === null ? String(row.year) : `${row.month} ${row.year}`;

/**
 * The population result's data notes. `unexpectedValues` and `yearlessRows`
 * count the year-end and companion series; the nowcast's own counts are added
 * here.
 */
function dataNotes(options: {
  nowcast: NowcastResult | undefined;
  providers: readonly Provider[];
  unexpectedValues: number;
  yearlessRows: number;
}): string[] {
  const notes = [...STOCK_NOTES];
  if (options.providers.includes('UNRWA')) {
    notes.push(
      'unrwa_refugees counts Palestine refugees registered with UNRWA, a separate series shown beside the row; it is never added into refugees.',
    );
  }
  if (options.providers.includes('IDMC')) {
    notes.push(
      "idmc_conflict_idps is IDMC's estimate of people internally displaced by conflict and violence — the series UNHCR uses for its total-forcibly-displaced headline. It differs from idps and is never added into it.",
    );
  }
  const period = options.nowcast?.rows[0];
  if (period) {
    notes.push(
      `Nowcast figures are estimates for ${snapshotLabel(period)}, sourced per country as the source field says.`,
    );
  }
  const unexpectedValues = options.unexpectedValues + (options.nowcast?.unexpectedValues ?? 0);
  if (unexpectedValues > 0) {
    notes.push(
      `${unexpectedValues} upstream value(s) were neither a number nor "-" and are reported as null.`,
    );
  }
  if (options.yearlessRows > 0) {
    notes.push(`${options.yearlessRows} upstream row(s) carried no usable year and were left out.`);
  }
  if (options.nowcast?.skippedRows) {
    notes.push(
      `${options.nowcast.skippedRows} nowcast row(s) carried no usable year and were left out.`,
    );
  }
  return notes;
}

const nowcastSchema = z
  .object({
    asylum_iso3: z.string().nullable().describe('Asylum country, ISO3. Null for the world total.'),
    asylum_unhcr_code: z
      .string()
      .nullable()
      .describe("UNHCR's code for the asylum country. Null for the world total."),
    asylum_name: z.string().nullable().describe('Asylum country name. Null for the world total.'),
    year: z.number().int().describe('Year of the estimate.'),
    month: z
      .string()
      .nullable()
      .describe('Month name of the estimate (e.g. "August"). Null when UNHCR sent none.'),
    refugees: countField('Estimated refugees.'),
    asylum_seekers: countField('Estimated asylum-seekers.'),
    source: z
      .string()
      .nullable()
      .describe(
        'Provenance of the estimate, as UNHCR labels it (a comma-separated list). Null when UNHCR sent none.',
      ),
  })
  .describe("One row of UNHCR's current-year estimate.");

export const getPopulationTool = tool('unhcr_get_population', {
  title: 'UNHCR displacement stocks',
  description:
    "Get UNHCR year-end displacement stocks (1951 to the latest year) by country of origin and/or asylum: refugees, asylum-seekers, other people in need of international protection, IDPs, stateless people, others of concern, and host communities, plus refugees and IDPs who returned during the year. Stocks count people in a situation on 31 December, not arrivals. Palestine refugees under UNRWA's mandate and IDMC's conflict-IDP estimate are separate series shown beside each row. Set include_nowcast for UNHCR's current-year estimate by asylum country; for sex and age breakdowns, use unhcr_get_demographics.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...scopeInputs,
    include_nowcast: blankAsUnset(z.boolean().default(false)).describe(
      "Append UNHCR's latest monthly estimate of refugees and asylum-seekers by asylum country: one current-year snapshot, independent of the year window. The nowcast has no origin dimension, so it is skipped when origin lists codes. When origin lists no codes, a window entirely after the latest published year returns the nowcast alone instead of failing.",
    ),
    sort_by: blankAsUnset(
      z
        .enum([
          'year',
          'refugees',
          'asylum_seekers',
          'oip',
          'idps',
          'stateless',
          'ooc',
          'hst',
          'returned_refugees',
          'returned_idps',
        ])
        .default('year'),
    ).describe(
      'Order of the full result before the inline cut. year (default) orders by year, then origin ISO3, then asylum ISO3; a count field orders largest first, nulls last.',
    ),
    ...resultInputs,
  }),

  output: z.object({
    rows: z
      .array(
        z
          .object({
            ...identityFields,
            refugees: countField('Refugees, including people in refugee-like situations.'),
            asylum_seekers: countField('Asylum-seekers awaiting a decision.'),
            oip: countField('Other people in need of international protection.'),
            idps: countField(
              'Conflict IDPs UNHCR protects or assists, including IDP-like situations.',
            ),
            stateless: countField('Stateless people.'),
            ooc: countField('Others of concern to UNHCR.'),
            hst: countField('Host community.'),
            returned_refugees: countField(
              'Refugees who returned during the year (a flow), recorded against the country returned from.',
            ),
            returned_idps: countField(
              'IDPs who returned during the year (a flow), recorded against the origin country.',
            ),
            unrwa_refugees: countField(
              'Palestine refugees registered with UNRWA; a separate series, never inside refugees. Present only where UNRWA has a row for this year and scope.',
            ).optional(),
            idmc_conflict_idps: countField(
              "IDMC's estimate of people displaced by conflict and violence; a separate series from idps. Present only where IDMC has a row for this year and scope.",
            ).optional(),
          })
          .describe('One year of stocks for one origin/asylum scope.'),
      )
      .describe('Inline rows, sorted, up to limit.'),
    ...sharedResultFields,
    footnotes: z
      .array(footnoteSchema)
      .describe(
        'UNHCR caveats matching rows of the full result, country-specific first; at most 20.',
      ),
    footnotes_total: z.number().int().describe('Caveats matching the full result, before the cap.'),
    nowcast: z
      .array(nowcastSchema)
      .optional()
      .describe('Present when include_nowcast was set and origin lists no codes.'),
  }),

  enrichment: dataEnrichment,

  errors: [
    {
      reason: 'unknown_country_code',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: "An origin or asylum value is not an ISO3 code in UNHCR's country list (after ISO2 normalization)",
      recovery:
        'Find the country with unhcr_list_reference (topic countries, name_contains) and pass its ISO3 code.',
    },
    {
      reason: 'invalid_year_window',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'year_from is later than year_to',
      recovery:
        'Set year_from no later than year_to, or omit one bound to run to the edge of coverage.',
    },
    {
      reason: 'year_out_of_coverage',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: "The whole requested window lies outside the dataset's published years, unless include_nowcast is set without origin codes and the window starts after the latest year (the nowcast is then returned instead)",
      recovery:
        'Request years inside the span unhcr_list_reference (topic coverage) reports for this dataset.',
    },
    {
      reason: 'conflicting_scope',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'expand names a dimension that origin or asylum already filters',
      recovery:
        'Either list codes in origin/asylum or expand that dimension, not both; drop the codes to list every country.',
    },
    {
      reason: 'upstream_busy',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: "This server's UNHCR request queue cannot start the call's requests before its deadline, or UNHCR answered 429",
      recovery:
        'Wait the retryAfter seconds the error carries, then retry; a narrower year window or no expand needs fewer upstream requests.',
    },
  ],

  async handler(input, ctx) {
    const service = getUnhcrService();
    const resolved = await resolveScope(input, 'population', ctx);

    if (!resolved.ok) {
      const { failure } = resolved;
      const afterCoverage =
        failure.reason === 'year_out_of_coverage' &&
        failure.window.year_from > failure.coverage.latestYear;

      if (afterCoverage && input.include_nowcast && failure.dimensions.origin.mode !== 'listed') {
        const nowcast = await service.nowcast(failure.dimensions.asylum, ctx);
        const period = nowcast.rows[0];
        ctx.enrich.notice(
          period
            ? `Year-end figures stop at ${failure.coverage.latestYear}, so no population rows fall in the requested window. The nowcast is UNHCR's ${snapshotLabel(period)} estimate of refugees and asylum-seekers by asylum country.`
            : `Year-end figures stop at ${failure.coverage.latestYear}, and UNHCR's nowcast has no row for this asylum scope.`,
        );
        return {
          rows: [],
          total_rows: 0,
          complete: true,
          measure: 'stock' as const,
          applied_scope: appliedScope(
            failure.dimensions,
            failure.window.year_from,
            failure.window.year_to,
          ),
          latest_year: failure.coverage.latestYear,
          data_notes: dataNotes({ nowcast, providers: [], unexpectedValues: 0, yearlessRows: 0 }),
          attribution: buildAttribution([]),
          footnotes: [],
          footnotes_total: 0,
          nowcast: nowcast.rows,
        };
      }

      const hint = afterCoverage
        ? `${failure.hint} For current-year estimates by asylum country, set include_nowcast and omit origin.`
        : failure.hint;
      throw ctx.fail(failure.reason, failure.message, {
        ...ctx.recoveryFor(failure.reason),
        ...failure.data,
        ...(hint && { recovery: { hint } }),
      });
    }

    const { scope } = resolved;
    const originListed = scope.origin.mode === 'listed';
    const [population, unrwa, idmc, footnotes, nowcast] = await Promise.all([
      service.population(scope.query, ctx),
      service.unrwa(scope.query, ctx),
      service.idmc(scope.query, ctx),
      service.footnotes(ctx),
      input.include_nowcast && !originListed ? service.nowcast(scope.asylum, ctx) : undefined,
    ]);

    const unrwaByKey = companionIndex(unrwa.rows);
    const idmcByKey = companionIndex(idmc.rows);
    const providers = new Set<Provider>();
    const rows: JoinedRow[] = population.rows.map((row) => {
      const key = rowKey(row);
      const joined: JoinedRow = { ...row };
      if (unrwaByKey.has(key)) {
        joined.unrwa_refugees = unrwaByKey.get(key) ?? null;
        providers.add('UNRWA');
      }
      if (idmcByKey.has(key)) {
        joined.idmc_conflict_idps = idmcByKey.get(key) ?? null;
        providers.add('IDMC');
      }
      return joined;
    });

    const matched = matchFootnotes(footnotes, rows, POPULATION_FOOTNOTE_TYPES);
    const notices =
      input.include_nowcast && originListed
        ? [
            'include_nowcast was skipped: the nowcast has no origin dimension. Omit origin to get current-year estimates by asylum country.',
          ]
        : [];
    const complete = population.complete && unrwa.complete && idmc.complete;
    const finished = await finishRows(ctx, {
      sourceTool: 'unhcr_get_population',
      datasetLabel: 'population',
      queryParams: { ...input },
      dimensions: scope,
      window: { clamps: scope.clamps, yearFrom: scope.query.yearFrom, yearTo: scope.query.yearTo },
      rows,
      fetchedRows: population.rows.length + population.skippedRows,
      complete,
      sortBy: input.sort_by,
      limit: input.limit,
      stage: input.stage,
      countFields: [...POPULATION_FIELDS, 'unrwa_refugees', 'idmc_conflict_idps'],
      providers: [...providers],
      notices,
    });

    return {
      rows: finished.rows,
      total_rows: finished.total_rows,
      complete,
      measure: 'stock' as const,
      applied_scope: scope.applied,
      latest_year: scope.coverage.latestYear,
      ...(finished.dataset && { dataset: finished.dataset }),
      data_notes: dataNotes({
        nowcast,
        providers: [...providers],
        unexpectedValues:
          population.unexpectedValues + unrwa.unexpectedValues + idmc.unexpectedValues,
        yearlessRows: population.skippedRows + unrwa.skippedRows + idmc.skippedRows,
      }),
      attribution: finished.attribution,
      footnotes: matched.footnotes,
      footnotes_total: matched.total,
      ...(nowcast && { nowcast: nowcast.rows }),
    };
  },

  format: (result) => {
    const hasUnrwa = result.rows.some((row) => row.unrwa_refugees !== undefined);
    const hasIdmc = result.rows.some((row) => row.idmc_conflict_idps !== undefined);
    const lines = [...renderResultHeader(result), ''];

    if (result.rows.length > 0) {
      lines.push(
        table(
          [
            'Year',
            'Origin',
            'Asylum',
            'Refugees',
            'Asylum-seekers',
            'OIP',
            'IDPs',
            'Stateless',
            'Others of concern',
            'Host community',
            'Returned refugees',
            'Returned IDPs',
            ...(hasUnrwa ? ['UNRWA refugees'] : []),
            ...(hasIdmc ? ['IDMC conflict IDPs'] : []),
          ],
          result.rows.map((row) => [
            String(row.year),
            ...identityCells(row),
            count(row.refugees),
            count(row.asylum_seekers),
            count(row.oip),
            count(row.idps),
            count(row.stateless),
            count(row.ooc),
            count(row.hst),
            count(row.returned_refugees),
            count(row.returned_idps),
            ...(hasUnrwa ? [count(row.unrwa_refugees)] : []),
            ...(hasIdmc ? [count(row.idmc_conflict_idps)] : []),
          ]),
        ),
        '',
        '— marks null: not applicable or not collected.',
        '',
      );
    } else {
      lines.push('_No year-end rows._', '');
    }

    if (result.nowcast) {
      lines.push(
        '### Nowcast',
        result.nowcast.length > 0
          ? table(
              ['Asylum', 'Year', 'Month', 'Refugees', 'Asylum-seekers', 'Source'],
              result.nowcast.map((row) => [
                countryCell(row.asylum_iso3, row.asylum_unhcr_code, row.asylum_name),
                String(row.year),
                row.month === null ? '—' : cell(row.month),
                count(row.refugees),
                count(row.asylum_seekers),
                row.source === null ? '—' : cell(row.source),
              ]),
            )
          : '_No nowcast rows for this asylum scope._',
        '',
      );
    }

    lines.push(...renderFootnotes(result.footnotes, result.footnotes_total), '');
    lines.push(...renderNotesAndAttribution(result.data_notes, result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
