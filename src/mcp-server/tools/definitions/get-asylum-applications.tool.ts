/**
 * @fileoverview unhcr_get_asylum_applications — asylum applications lodged per
 * year (2000 to the latest year) by origin and/or asylum country. Upstream rows
 * are split by authority × application stage × decision level × unit; the
 * tool sums over the dimensions `split_by` leaves out (stage stays split by
 * default, so new claims are not added to appeals) and never adds cases to
 * persons. UNHCR's footnotes are matched to the summed rows.
 * @module mcp-server/tools/definitions/get-asylum-applications
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { aggregateApplications } from '@/services/unhcr/asylum-aggregate.js';
import { APPLICATION_STAGES } from '@/services/unhcr/codes.js';
import { asylumRowTypes, matchFootnotes } from '@/services/unhcr/footnote-match.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import {
  blankAsUnset,
  codeList,
  resultInputs,
  scopeInputs,
  splitByList,
} from '../shared/inputs.js';
import { count, table } from '../shared/markdown.js';
import {
  asylumEmptyNotice,
  codesCell,
  codesField,
  countField,
  dataEnrichment,
  identityCells,
  identityFields,
  normalizationNotes,
  renderAsylumLegend,
  renderFootnotes,
  renderNotesAndAttribution,
  renderResultHeader,
  sharedResultFields,
} from '../shared/outputs.js';
import { finishRows } from '../shared/results.js';
import { resolveScope } from '../shared/scope.js';

function dataNotes(options: {
  otherStages: boolean;
  skippedRows: number;
  unexpectedValues: number;
  yearlessRows: number;
}): string[] {
  const notes = [
    'Counts are flows: asylum applications lodged during the reporting period. A footnote can narrow the period a row covers, so check the footnotes before comparing years.',
    'Each row states its unit. Some countries report cases, where one case can cover several people; counts of cases are never added to counts of persons.',
    'authorities, stages, and decision_levels list the codes summed into each row; decode them with unhcr_list_reference (topic asylum_codes).',
    'Values below 5 are rounded to the nearest multiple of 5, so small counts are approximate.',
    'null means UNHCR marks the figure not applicable or not collected; it is never zero.',
  ];
  if (options.otherStages) {
    notes.push(
      'Repeat and appeal applications can concern people already counted as new applicants; filter stages to N for new applications.',
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

/** This tool's list inputs for one normalize mode. */
export const applicationLists = (normalize: boolean) => ({
  split_by: splitByList(['authority', 'stage', 'decision_level'], normalize, (list) =>
    list.default(['stage']),
  ).describe(
    'Procedure dimensions kept as separate rows: authority (government, UNHCR, or joint), stage (new, repeat, appeal, …), decision_level. Every dimension left out is summed. Default ["stage"]; [] gives one total per year and scope for each unit. Unit is always kept separate.',
  ),
  stages: codeList(APPLICATION_STAGES, 'An application-stage code.', normalize).describe(
    'Keep only these application stages before summing, case-insensitive: N new, R repeat, A appeal, NA new and appeal together, NR new and repeat together, FA first and appeal, J judiciary, BL backlog, SP subsidiary protection; V and RA appear in the data without a published definition. ["N"] gives new applications only, the basis of UNHCR\'s headline figure. Omit for every stage.',
  ),
});

export const getAsylumApplicationsTool = tool('unhcr_get_asylum_applications', {
  title: 'UNHCR asylum applications',
  description:
    'Get asylum applications lodged per year (2000 to the latest year) by country of origin and/or asylum, split by default into application stage — new, repeat, appeal, and the combined stages some countries report — so new claims are not added to appeals of old ones. Counts given as cases are never added to counts of persons; each row states its unit. Decode stage, authority, and decision-level codes with unhcr_list_reference (topic asylum_codes).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...scopeInputs,
    ...applicationLists(true),
    sort_by: blankAsUnset(z.enum(['year', 'applied']).default('year')).describe(
      'Order of the full result before the inline cut. year (default) orders by year, then origin ISO3, then asylum ISO3; applied orders largest first, nulls last.',
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
            stages: codesField('stage', 'Application-stage codes'),
            decision_levels: codesField('decision level', 'Decision-level codes'),
            unit: z
              .enum(['persons', 'cases'])
              .describe('What applied counts: persons, or cases that can cover several people.'),
            applied: countField('Applications lodged during the year, in this row’s unit.'),
          })
          .describe('One year of applications for one origin/asylum scope, stage split, and unit.'),
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
      reason: 'too_many_country_codes',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      thrownBy: 'service',
      when: 'origin or asylum lists more distinct codes than one filter accepts',
      recovery:
        'List fewer distinct codes in origin or asylum, or leave that filter empty and set expand to list every country.',
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
    const resolved = await resolveScope(input, 'asylum-applications', ctx);
    if (!resolved.ok) {
      const { failure } = resolved;
      throw ctx.fail(failure.reason, failure.message, {
        ...failure.data,
        ...(failure.hint && { recovery: { hint: failure.hint } }),
      });
    }

    const { scope } = resolved;
    const service = getUnhcrService();
    const [fetched, footnotes] = await Promise.all([
      service.asylumApplications(scope.query, ctx),
      service.footnotes(ctx),
    ]);
    const stages = input.stages ?? [];
    const aggregated = aggregateApplications(fetched.rows, { splitBy: input.split_by, stages });
    const filter = stages.length > 0 ? `stages=${stages.join(', ')}` : undefined;
    const emptyNotice = asylumEmptyNotice({
      aggregatedRows: aggregated.rows.length,
      fetchedRows: fetched.rows.length,
      filter,
      skippedRows: aggregated.skippedRows,
    });
    const finished = await finishRows(ctx, {
      dataset: 'asylum-applications',
      sourceTool: 'unhcr_get_asylum_applications',
      datasetLabel: 'asylum-application',
      queryParams: { ...input },
      scope,
      rows: aggregated.rows,
      fetchedRows: fetched.rows.length + fetched.skippedRows,
      complete: fetched.complete,
      sortBy: input.sort_by,
      limit: input.limit,
      stage: input.stage,
      countFields: ['authorities', 'stages', 'decision_levels', 'unit', 'applied'],
      columnTypes: {
        authorities: 'VARCHAR',
        stages: 'VARCHAR',
        decision_levels: 'VARCHAR',
        unit: 'VARCHAR',
      },
      providers: [],
      notices: [],
      emptyNotice,
      yearlessRows: fetched.skippedRows,
    });
    const matched = matchFootnotes(footnotes, finished.sorted, asylumRowTypes, finished.limit);

    return {
      ...finished.output,
      measure: 'flow' as const,
      data_notes: dataNotes({
        otherStages: aggregated.rows.some((row) => row.stages.some((code) => code !== 'N')),
        skippedRows: aggregated.skippedRows,
        unexpectedValues: fetched.unexpectedValues,
        yearlessRows: fetched.skippedRows,
      }),
      footnotes: matched.footnotes,
      footnotes_total: matched.total,
    };
  },

  format: (result) => {
    const lines = [...renderResultHeader(result), ''];
    if (result.rows.length > 0) {
      lines.push(
        table(
          ['Year', 'Origin', 'Asylum', 'Authority', 'Stage', 'Decision level', 'Unit', 'Applied'],
          result.rows.map((row) => [
            String(row.year),
            ...identityCells(row),
            codesCell(row.authorities),
            codesCell(row.stages),
            codesCell(row.decision_levels),
            row.unit,
            count(row.applied),
          ]),
        ),
        '',
        '— marks null: not applicable or not collected.',
        '',
        ...renderAsylumLegend([
          {
            title: 'Authority',
            list: 'authority',
            codes: result.rows.flatMap((row) => row.authorities),
          },
          {
            title: 'Stage',
            list: 'application_stage',
            codes: result.rows.flatMap((row) => row.stages),
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
    lines.push(...renderFootnotes(result.footnotes, result.footnotes_total), '');
    lines.push(...renderNotesAndAttribution(result.data_notes, result.attribution));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
