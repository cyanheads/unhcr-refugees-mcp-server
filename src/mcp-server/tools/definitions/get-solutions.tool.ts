/**
 * @fileoverview unhcr_get_solutions — durable solutions per year (1959 to the
 * latest year) by origin and/or asylum country: refugee returns, resettlement
 * arrivals, naturalisations, and IDP returns, with matched UNHCR footnotes.
 * Reuses the population pipeline without companion series.
 * @module mcp-server/tools/definitions/get-solutions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { SOLUTIONS_FOOTNOTE_TYPES } from '@/services/unhcr/codes.js';
import { matchFootnotes } from '@/services/unhcr/footnote-match.js';
import { SOLUTIONS_FIELDS } from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { blankAsUnset, resultInputs, scopeInputs } from '../shared/inputs.js';
import { count, table } from '../shared/markdown.js';
import {
  countField,
  dataEnrichment,
  footnoteSchema,
  identityCells,
  identityFields,
  renderFootnotes,
  renderNotesAndAttribution,
  renderResultHeader,
  sharedResultFields,
} from '../shared/outputs.js';
import { finishRows } from '../shared/results.js';
import { resolveScope } from '../shared/scope.js';

function dataNotes(options: { unexpectedValues: number; yearlessRows: number }): string[] {
  const notes = [
    'Counts are flows: events during each calendar year, not people present at year end.',
    'The asylum country means something different per column: for returned_refugees it is the country refugees returned from, for resettlement the country they were resettled to, and for naturalisation the country that naturalised them. returned_idps sits on the origin country itself.',
    'Naturalisation is an incomplete proxy for local integration.',
    'Values below 5 are rounded to the nearest multiple of 5, so small counts are approximate.',
    'null means the figure was not collected for that country and year; it is not zero.',
  ];
  if (options.unexpectedValues > 0) {
    notes.push(
      `${options.unexpectedValues} upstream value(s) were neither a number nor "-" and are reported as null.`,
    );
  }
  if (options.yearlessRows > 0) {
    notes.push(`${options.yearlessRows} upstream row(s) carried no usable year and were left out.`);
  }
  return notes;
}

export const getSolutionsTool = tool('unhcr_get_solutions', {
  title: 'UNHCR durable solutions',
  description:
    'Get durable solutions per year (1959 to the latest year) by country of origin and/or asylum: refugees who returned home, refugees resettled to a third country, refugees naturalised, and IDPs who returned. The asylum country means something different per column: the country refugees returned from, the country they were resettled to, the country that naturalised them; IDP returns sit on the origin country itself. Null means the figure was not collected for that country and year, not zero.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...scopeInputs,
    sort_by: blankAsUnset(
      z
        .enum(['year', 'returned_refugees', 'resettlement', 'naturalisation', 'returned_idps'])
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
            returned_refugees: countField(
              'Refugees who returned to their origin country during the year, recorded against the country they returned from.',
            ),
            resettlement: countField(
              'Refugees resettled during the year, recorded against the country they were resettled to.',
            ),
            naturalisation: countField(
              'Refugees naturalised during the year, recorded against the naturalising country.',
            ),
            returned_idps: countField(
              'IDPs who returned during the year, recorded against the origin country itself.',
            ),
          })
          .describe('One year of durable solutions for one origin/asylum scope.'),
      )
      .describe('Inline rows, sorted, up to limit.'),
    ...sharedResultFields,
    footnotes: z
      .array(footnoteSchema)
      .describe(
        'UNHCR caveats matching rows of the full result, country-specific first; at most 20.',
      ),
    footnotes_total: z.number().int().describe('Caveats matching the full result, before the cap.'),
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
    const resolved = await resolveScope(input, 'solutions', ctx);
    if (!resolved.ok) {
      const { failure } = resolved;
      throw ctx.fail(failure.reason, failure.message, {
        ...ctx.recoveryFor(failure.reason),
        ...failure.data,
        ...(failure.hint && { recovery: { hint: failure.hint } }),
      });
    }

    const { scope } = resolved;
    const service = getUnhcrService();
    const [solutions, footnotes] = await Promise.all([
      service.solutions(scope.query, ctx),
      service.footnotes(ctx),
    ]);
    const matched = matchFootnotes(footnotes, solutions.rows, SOLUTIONS_FOOTNOTE_TYPES);
    const finished = await finishRows(ctx, {
      sourceTool: 'unhcr_get_solutions',
      datasetLabel: 'solutions',
      queryParams: { ...input },
      dimensions: scope,
      window: { clamps: scope.clamps, yearFrom: scope.query.yearFrom, yearTo: scope.query.yearTo },
      rows: solutions.rows,
      fetchedRows: solutions.rows.length + solutions.skippedRows,
      complete: solutions.complete,
      sortBy: input.sort_by,
      limit: input.limit,
      stage: input.stage,
      countFields: SOLUTIONS_FIELDS,
      providers: [],
      notices: [],
    });

    return {
      rows: finished.rows,
      total_rows: finished.total_rows,
      complete: solutions.complete,
      measure: 'flow' as const,
      applied_scope: scope.applied,
      latest_year: scope.coverage.latestYear,
      ...(finished.dataset && { dataset: finished.dataset }),
      data_notes: dataNotes({
        unexpectedValues: solutions.unexpectedValues,
        yearlessRows: solutions.skippedRows,
      }),
      attribution: finished.attribution,
      footnotes: matched.footnotes,
      footnotes_total: matched.total,
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
            'Returned refugees',
            'Resettlement',
            'Naturalisation',
            'Returned IDPs',
          ],
          result.rows.map((row) => [
            String(row.year),
            ...identityCells(row),
            count(row.returned_refugees),
            count(row.resettlement),
            count(row.naturalisation),
            count(row.returned_idps),
          ]),
        ),
        '',
        '— marks null: not collected for that country and year.',
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
