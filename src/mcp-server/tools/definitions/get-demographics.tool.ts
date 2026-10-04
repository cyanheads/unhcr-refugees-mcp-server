/**
 * @fileoverview unhcr_get_demographics — year-end stocks (2001 to the latest
 * year) by population type, sex, and age band, by origin and/or asylum
 * country, with the share of each total UNHCR could break down by sex. Rows
 * UNHCR has no breakdown for publish "0" in every band; those bands are
 * reported as null, since the zero means "not broken down", not zero people.
 * These totals come from a separate collection and need not match
 * unhcr_get_population.
 * @module mcp-server/tools/definitions/get-demographics
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DEMOGRAPHIC_TYPES, POPULATION_TYPES } from '@/services/unhcr/codes.js';
import { matchFootnotes, withFolded } from '@/services/unhcr/footnote-match.js';
import { pickIdentity } from '@/services/unhcr/normalize.js';
import type { DemographicsField, DemographicsRow, RowIdentity } from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { blankAsUnset, codeList, resultInputs, scopeInputs } from '../shared/inputs.js';
import { cell, count, table } from '../shared/markdown.js';
import {
  dataEnrichment,
  footnoteSchema,
  identityCells,
  identityFields,
  normalizationNotes,
  renderFootnotes,
  renderNotesAndAttribution,
  renderResultHeader,
  sharedResultFields,
} from '../shared/outputs.js';
import { finishRows } from '../shared/results.js';
import { resolveScope } from '../shared/scope.js';

const SEXES = [
  { key: 'female', upstream: 'f', label: 'Females', short: 'F' },
  { key: 'male', upstream: 'm', label: 'Males', short: 'M' },
] as const;

const AGE_BANDS = [
  { key: '0_4', upstream: '0_4', label: 'aged 0–4', short: '0–4' },
  { key: '5_11', upstream: '5_11', label: 'aged 5–11', short: '5–11' },
  { key: '12_17', upstream: '12_17', label: 'aged 12–17', short: '12–17' },
  { key: '18_59', upstream: '18_59', label: 'aged 18–59', short: '18–59' },
  { key: '60_plus', upstream: '60', label: 'aged 60 or older', short: '60+' },
  { key: 'unknown_age', upstream: 'other', label: 'of unknown age', short: 'unknown age' },
  { key: 'total', upstream: 'total', label: 'of all ages (the sum of the bands)', short: 'total' },
] as const;

type BandField = `${(typeof SEXES)[number]['key']}_${(typeof AGE_BANDS)[number]['key']}`;

/** The fourteen sex × age columns, female first, in output order. */
const BANDS = SEXES.flatMap((sex) =>
  AGE_BANDS.map((band) => ({
    field: `${sex.key}_${band.key}` as BandField,
    upstream: `${sex.upstream}_${band.upstream}` as DemographicsField,
    description: `${sex.label} ${band.label}.`,
    header: `${sex.short} ${band.short}`,
  })),
);

/** A demographics row in output shape. */
type DemographicsOutputRow = RowIdentity &
  Record<BandField, number | null> & {
    disaggregated: boolean;
    population_type: string | null;
    sex_disaggregated_share: number | null;
    total: number | null;
  };

/**
 * Shape one upstream row. When the sex totals are 0 but the row total is not,
 * UNHCR has no breakdown for the row: every band becomes null and
 * `disaggregated` false. The share is rounded to 4 decimal places.
 */
function toOutputRow(row: DemographicsRow): DemographicsOutputRow {
  const bySex = (row.f_total ?? 0) + (row.m_total ?? 0);
  const disaggregated = bySex > 0;
  const noBreakdown = !disaggregated && (row.total ?? 0) > 0;
  const bands = Object.fromEntries(
    BANDS.map((band) => [band.field, noBreakdown ? null : row[band.upstream]]),
  ) as Record<BandField, number | null>;
  return {
    ...pickIdentity(row),
    population_type: row.population_type,
    total: row.total,
    ...bands,
    disaggregated,
    sex_disaggregated_share: row.total ? Math.round((bySex / row.total) * 10_000) / 10_000 : null,
  };
}

/** Rows of one year and scope follow the `population_types` code order; unknown codes last. */
const TYPE_ORDER: readonly (string | null)[] = DEMOGRAPHIC_TYPES;
const typeRank = (code: string | null): number => {
  const rank = TYPE_ORDER.indexOf(code);
  return rank === -1 ? TYPE_ORDER.length : rank;
};

const typeLabel = (code: string | null): string => {
  if (code === null) return '—';
  const label = POPULATION_TYPES.find((type) => type.code === code)?.label;
  return cell(label ? `${code} ${label}` : code);
};

function dataNotes(counts: { unexpectedValues: number; yearlessRows: number }): string[] {
  return [
    'Counts are year-end stocks by population type: people in each situation on 31 December. Rows of type RET and RDP count returns during the year (flows).',
    'Coverage is partial. sex_disaggregated_share is (female_total + male_total) ÷ total, the share of the row UNHCR could break down by sex; the *_unknown_age bands count people of known sex and unknown age. Where a row has no breakdown (disaggregated false), every band is null: UNHCR publishes 0 there, which means not broken down, not zero people.',
    'Demographic totals come from a separate collection and can differ from unhcr_get_population for the same scope and year.',
    'Values below 5 are rounded to the nearest multiple of 5, so small counts are approximate.',
    'null means UNHCR has no breakdown for the row, or marks the figure not applicable or not collected; it is never zero.',
    ...normalizationNotes(counts),
  ];
}

const bandSchema = (description: string) =>
  z
    .number()
    .nullable()
    .describe(
      `${description} Null when UNHCR has no sex and age breakdown for the row, or marks it not applicable — never zero.`,
    );

const bandShape = Object.fromEntries(
  BANDS.map((band) => [band.field, bandSchema(band.description)]),
) as Record<BandField, ReturnType<typeof bandSchema>>;

const STAGED_TYPES: Partial<Record<keyof DemographicsOutputRow & string, ColumnSchema['type']>> = {
  population_type: 'VARCHAR',
  disaggregated: 'BOOLEAN',
  sex_disaggregated_share: 'DOUBLE',
};

export const getDemographicsTool = tool('unhcr_get_demographics', {
  title: 'UNHCR demographics',
  description:
    'Get UNHCR year-end stocks (2001 to the latest year) broken down by population type, sex, and age band (0–4, 5–11, 12–17, 18–59, 60+, unknown age), by country of origin and/or asylum. Coverage is partial: each row gives the share of its total that UNHCR could disaggregate by sex, and age bands are null where no breakdown exists. These totals come from a separate collection and need not match unhcr_get_population.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...scopeInputs,
    population_types: codeList(DEMOGRAPHIC_TYPES, 'A population-type code.').describe(
      'Keep only these population types, case-insensitive: REF refugees, ASY asylum-seekers, OIP other people in need of international protection, IDP internally displaced, STA stateless, OOC others of concern, HST host community, RET returned refugees, RDP returned IDPs. Decode them with unhcr_list_reference (topic population_types). Omit for every type.',
    ),
    sort_by: blankAsUnset(z.enum(['year', 'total']).default('year')).describe(
      'Order of the full result before the inline cut. year (default) orders by year, then origin ISO3, then asylum ISO3, then population type; total orders largest first, nulls last.',
    ),
    ...resultInputs,
  }),

  output: z.object({
    rows: z
      .array(
        z
          .object({
            ...identityFields,
            population_type: z
              .string()
              .nullable()
              .describe(
                'Population-type code (REF, ASY, OIP, IDP, STA, OOC, HST, RET, RDP); decode with unhcr_list_reference (topic population_types).',
              ),
            total: z
              .number()
              .nullable()
              .describe(
                'Everyone of this population type in this scope, broken down or not. Null when UNHCR marks it not applicable or not collected.',
              ),
            ...bandShape,
            disaggregated: z
              .boolean()
              .describe(
                'True when UNHCR has any sex breakdown for this row; false means every band is null.',
              ),
            sex_disaggregated_share: z
              .number()
              .nullable()
              .describe(
                'Fraction on a 0–1 scale, 4 decimal places: (female_total + male_total) ÷ total, the share of the row UNHCR could break down by sex. Null when total is 0.',
              ),
          })
          .describe('One year of one population type for one origin/asylum scope.'),
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
    const resolved = await resolveScope(input, 'demographics', ctx);
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
      service.demographics(scope.query, ctx),
      service.footnotes(ctx),
    ]);
    const types = input.population_types ?? [];
    const wanted = new Set<string>(types);
    const rows = fetched.rows
      .filter((row) => types.length === 0 || wanted.has(row.population_type ?? ''))
      .map(toOutputRow)
      .sort((a, b) => typeRank(a.population_type) - typeRank(b.population_type));

    // Each row is one population type, so the filter narrows the footnotes with the rows.
    const matched = matchFootnotes(footnotes, rows, (row) => withFolded(row.population_type));
    const filterEmptied = types.length > 0 && fetched.rows.length > 0 && rows.length === 0;
    const finished = await finishRows(ctx, {
      sourceTool: 'unhcr_get_demographics',
      datasetLabel: 'demographics',
      queryParams: { ...input },
      scope,
      rows,
      fetchedRows: fetched.rows.length + fetched.skippedRows,
      complete: fetched.complete,
      sortBy: input.sort_by,
      limit: input.limit,
      stage: input.stage,
      countFields: [
        'population_type',
        'total',
        ...BANDS.map((band) => band.field),
        'disaggregated',
        'sex_disaggregated_share',
      ],
      columnTypes: STAGED_TYPES,
      providers: [],
      notices: [],
      emptyNotice: filterEmptied
        ? `No rows matched population_types=${types.join(', ')}. Drop the filter or check the codes with unhcr_list_reference (topic population_types).`
        : undefined,
      yearlessRows: fetched.skippedRows,
    });

    return {
      ...finished,
      measure: 'stock' as const,
      data_notes: dataNotes({
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
          [
            'Year',
            'Origin',
            'Asylum',
            'Type',
            'Total',
            'Disaggregated',
            'Share by sex',
            ...BANDS.map((band) => band.header),
          ],
          result.rows.map((row) => [
            String(row.year),
            ...identityCells(row),
            typeLabel(row.population_type),
            count(row.total),
            row.disaggregated ? 'yes' : 'no',
            row.sex_disaggregated_share === null
              ? '—'
              : `${(row.sex_disaggregated_share * 100).toFixed(2)}%`,
            ...BANDS.map((band) => count(row[band.field])),
          ]),
        ),
        '',
        '— marks null: no sex and age breakdown for the row, or not applicable or not collected.',
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
