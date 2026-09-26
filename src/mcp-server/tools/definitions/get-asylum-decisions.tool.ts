/**
 * @fileoverview unhcr_get_asylum_decisions — asylum decisions per year (2000 to
 * the latest year) by origin and/or asylum country and outcome, with UNHCR's
 * Refugee Recognition Rate and Total Protection Rate computed from summed
 * counts over substantive decisions (otherwise-closed cases excluded). All
 * decision levels are summed by default and each row lists the levels it
 * includes; cases and persons are never added together.
 * @module mcp-server/tools/definitions/get-asylum-decisions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { aggregateDecisions } from '@/services/unhcr/asylum-aggregate.js';
import { DECISION_LEVELS } from '@/services/unhcr/codes.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { blankAsUnset, codeList, resultInputs, scopeInputs } from '../shared/inputs.js';
import { count, table } from '../shared/markdown.js';
import {
  codesCell,
  countField,
  dataEnrichment,
  identityCells,
  identityFields,
  normalizationNotes,
  renderAsylumLegend,
  renderNotesAndAttribution,
  renderResultHeader,
  sharedResultFields,
} from '../shared/outputs.js';
import { finishRows } from '../shared/results.js';
import { resolveScope } from '../shared/scope.js';

function dataNotes(options: {
  multiLevel: boolean;
  skippedRows: number;
  staged: boolean;
  unexpectedValues: number;
  yearlessRows: number;
}): string[] {
  const notes = [
    'Counts are flows: asylum decisions made during each calendar year.',
    'refugee_recognition_rate = recognized ÷ substantive_decisions × 100, and total_protection_rate = (recognized + complementary_protection) ÷ substantive_decisions × 100, UNHCR’s definitions. substantive_decisions = recognized + complementary_protection + rejected, and is null when any of the three is null in any upstream row summed into it, so no rate rests on a partial denominator; otherwise_closed cases are excluded from both rates. Rates are computed from each row’s summed counts and are null when substantive_decisions is 0 or null.',
    'total_decisions sums UNHCR’s published totals, which can differ from the sum of the four outcomes because of rounding.',
    'Rates on small counts are unreliable: counts below 10 are rounded to the nearest multiple of 5.',
    'Each row states its unit. Some countries report cases, where one case can cover several people; counts of cases are never added to counts of persons.',
    'null means UNHCR marks the figure not applicable or not collected; it is never zero.',
  ];
  if (options.multiLevel) {
    notes.push(
      'Some rows sum several decision levels (listed in decision_levels). Appeal-stage decisions can concern people already decided at first instance, so split_by decision_level or filter decision_levels to FI for first-instance rates.',
    );
  }
  if (options.staged) {
    notes.push(
      'To aggregate rates across rows in SQL, recompute them from SUM(recognized), SUM(complementary_protection), and SUM(substantive_decisions) over rows where substantive_decisions is not null; never average the rate columns.',
    );
  }
  if (options.skippedRows > 0) {
    notes.push(
      `${options.skippedRows} upstream row(s) carried a unit code other than P (persons) or C (cases) and were left out.`,
    );
  }
  notes.push(...normalizationNotes(options));
  return notes;
}

const codesField = (dimension: string, list: string) =>
  z
    .array(z.string().describe(`One ${dimension} code.`))
    .describe(
      `${list} summed into this row; a single code when split_by keeps ${dimension} separate.`,
    );

const rateField = (description: string) =>
  z
    .number()
    .nullable()
    .describe(
      `Percent on a 0–100 scale, 1 decimal place. ${description} Null when substantive_decisions is 0 or null.`,
    );

/** A rate as a percentage cell; null (a rate that cannot be computed) as an em dash. */
const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);

export const getAsylumDecisionsTool = tool('unhcr_get_asylum_decisions', {
  title: 'UNHCR asylum decisions',
  description:
    "Get asylum decisions per year (2000 to the latest year) by country of origin and/or asylum: recognized as refugees, complementary protection, rejected, and otherwise closed, with UNHCR's Refugee Recognition Rate and Total Protection Rate computed over substantive decisions (otherwise-closed cases excluded). By default all decision levels are summed and each row lists the levels it includes; appeal-stage decisions can concern people already decided at first instance, so split_by decision_level or filter decision_levels to FI for first-instance rates. Cases and persons are never added together.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...scopeInputs,
    split_by: blankAsUnset(
      z
        .array(
          z
            .enum(['authority', 'decision_level'])
            .describe('A procedure dimension to keep separate.'),
        )
        .max(2)
        .default([]),
    ).describe(
      'Procedure dimensions kept as separate rows: authority (government, UNHCR, or joint) and decision_level (first instance, administrative review, …). Every dimension left out is summed. Default [] sums all authorities and levels, as UNHCR does for its rates. Unit is always kept separate.',
    ),
    decision_levels: codeList(DECISION_LEVELS, 'A decision-level code.').describe(
      'Keep only these decision levels before summing, case-insensitive: NA new applications, FI first instance, AR administrative review, RA repeat/reopened, IN US Citizenship and Immigration Services, EO US Executive Office for Immigration Review, JR judicial review, SP subsidiary protection, FA first instance and appeal, TP temporary protection, TA temporary asylum, BL backlog, TR temporary leave to remain, CA cantonal regulations (Switzerland). ["FI"] gives first-instance decisions. Omit for every level.',
    ),
    sort_by: blankAsUnset(
      z
        .enum(['year', 'total_decisions', 'substantive_decisions', 'recognized', 'rejected'])
        .default('year'),
    ).describe(
      'Order of the full result before the inline cut. year (default) orders by year, then origin ISO3, then asylum ISO3; a count field orders largest first, nulls last. Rates are not sortable, since rates on small rounded counts would crowd the top.',
    ),
    ...resultInputs,
  }),

  output: z.object({
    rows: z
      .array(
        z
          .object({
            ...identityFields,
            authorities: codesField('authority', 'Authority codes'),
            decision_levels: codesField('decision level', 'Decision-level codes'),
            unit: z
              .enum(['persons', 'cases'])
              .describe('What the counts count: persons, or cases that can cover several people.'),
            recognized: countField('Decisions granting refugee status.'),
            complementary_protection: countField(
              'Decisions granting complementary protection instead of refugee status.',
            ),
            rejected: countField('Decisions rejecting the claim on its merits.'),
            otherwise_closed: countField(
              'Cases closed without a substantive decision, such as withdrawn or abandoned claims.',
            ),
            total_decisions: countField(
              'Sum of UNHCR’s published decision totals; rounding can set it apart from the four outcomes.',
            ),
            substantive_decisions: countField(
              'recognized + complementary_protection + rejected: the rates’ denominator, null when any of the three is null in any upstream row summed into this row, rather than summed from the rest.',
            ),
            refugee_recognition_rate: rateField(
              'Refugee Recognition Rate: recognized ÷ substantive_decisions × 100.',
            ),
            total_protection_rate: rateField(
              'Total Protection Rate: (recognized + complementary_protection) ÷ substantive_decisions × 100.',
            ),
          })
          .describe('One year of decisions for one origin/asylum scope, level split, and unit.'),
      )
      .describe('Inline rows, sorted, up to limit.'),
    ...sharedResultFields,
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
      when: "The whole requested window lies outside the dataset's published years",
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
    const resolved = await resolveScope(input, 'asylum-decisions', ctx);
    if (!resolved.ok) {
      const { failure } = resolved;
      throw ctx.fail(failure.reason, failure.message, {
        ...ctx.recoveryFor(failure.reason),
        ...failure.data,
        ...(failure.hint && { recovery: { hint: failure.hint } }),
      });
    }

    const { scope } = resolved;
    const fetched = await getUnhcrService().asylumDecisions(scope.query, ctx);
    const decisionLevels = input.decision_levels ?? [];
    const aggregated = aggregateDecisions(fetched.rows, {
      splitBy: input.split_by,
      decisionLevels,
    });
    const filter =
      decisionLevels.length > 0 ? `decision_levels=${decisionLevels.join(', ')}` : undefined;
    let emptyNotice: string | undefined;
    if (fetched.rows.length > 0 && aggregated.rows.length === 0) {
      emptyNotice =
        aggregated.skippedRows > 0
          ? `UNHCR returned ${aggregated.skippedRows} row(s)${filter ? ` matching ${filter}` : ''}, all with a unit code other than P (persons) or C (cases); they were left out rather than guessed.`
          : `No rows matched ${filter}. Drop the filter or check the codes with unhcr_list_reference (topic asylum_codes).`;
    }
    const finished = await finishRows(ctx, {
      sourceTool: 'unhcr_get_asylum_decisions',
      datasetLabel: 'asylum-decision',
      queryParams: { ...input },
      scope,
      rows: aggregated.rows,
      fetchedRows: fetched.rows.length + fetched.skippedRows,
      complete: fetched.complete,
      sortBy: input.sort_by,
      limit: input.limit,
      stage: input.stage,
      countFields: [
        'authorities',
        'decision_levels',
        'unit',
        'recognized',
        'complementary_protection',
        'rejected',
        'otherwise_closed',
        'total_decisions',
        'substantive_decisions',
        'refugee_recognition_rate',
        'total_protection_rate',
      ],
      columnTypes: {
        authorities: 'VARCHAR',
        decision_levels: 'VARCHAR',
        unit: 'VARCHAR',
        refugee_recognition_rate: 'DOUBLE',
        total_protection_rate: 'DOUBLE',
      },
      providers: [],
      notices: [],
      emptyNotice,
      yearlessRows: fetched.skippedRows,
    });

    return {
      ...finished,
      measure: 'flow' as const,
      data_notes: dataNotes({
        multiLevel: aggregated.rows.some((row) => row.decision_levels.length > 1),
        skippedRows: aggregated.skippedRows,
        staged: finished.dataset !== undefined,
        unexpectedValues: fetched.unexpectedValues,
        yearlessRows: fetched.skippedRows,
      }),
    };
  },

  format: (result) => {
    const lines = [...renderResultHeader(result), ''];
    if (result.rows.length > 0) {
      lines.push(
        table(
          [
            'Year',
            'Origin',
            'Asylum',
            'Authority',
            'Decision level',
            'Unit',
            'Recognized',
            'Complementary protection',
            'Rejected',
            'Otherwise closed',
            'Total decisions',
            'Substantive decisions',
            'Recognition rate',
            'Total protection rate',
          ],
          result.rows.map((row) => [
            String(row.year),
            ...identityCells(row),
            codesCell(row.authorities),
            codesCell(row.decision_levels),
            row.unit,
            count(row.recognized),
            count(row.complementary_protection),
            count(row.rejected),
            count(row.otherwise_closed),
            count(row.total_decisions),
            count(row.substantive_decisions),
            percent(row.refugee_recognition_rate),
            percent(row.total_protection_rate),
          ]),
        ),
        '',
        '— marks null: not applicable or not collected, or a rate that cannot be computed (no substantive decisions, or a null count in it).',
        '',
        ...renderAsylumLegend([
          {
            title: 'Authority',
            list: 'authority',
            codes: result.rows.flatMap((row) => row.authorities),
          },
          {
            title: 'Decision level',
            list: 'decision_level',
            codes: result.rows.flatMap((row) => row.decision_levels),
          },
        ]),
        '',
      );
    } else {
      lines.push('_No rows._', '');
    }
    lines.push(...renderNotesAndAttribution(result.data_notes, result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
