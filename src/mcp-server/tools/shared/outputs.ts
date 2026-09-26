/**
 * @fileoverview Output schema pieces shared by the unhcr_get_* data tools and
 * the markdown renderers for them. Each data tool's row schema starts with the
 * identity fields here; the result carries the shared scope, coverage,
 * staging, notes, and attribution fields.
 * @module mcp-server/tools/shared/outputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { type ASYLUM_CODES, asylumCodeLabel } from '@/services/unhcr/codes.js';
import type { MatchedFootnote } from '@/services/unhcr/footnote-match.js';
import type { RowIdentity } from '@/services/unhcr/types.js';
import { blockquote, cell, inline } from './markdown.js';

/** Identity columns every data row starts with. */
export const identityFields = {
  year: z.number().int().describe('Calendar year of the figure.'),
  origin_iso3: z
    .string()
    .nullable()
    .describe('Country of origin, ISO3. Null when origins are summed into this row.'),
  origin_unhcr_code: z
    .string()
    .nullable()
    .describe(
      "UNHCR's own code for the origin country (GFR for Germany), for matching UNHCR publications; origin and asylum take the ISO3 code, not this. Null when summed.",
    ),
  origin_name: z.string().nullable().describe('Origin country name. Null when summed.'),
  asylum_iso3: z
    .string()
    .nullable()
    .describe('Country of asylum, ISO3. Null when asylum countries are summed into this row.'),
  asylum_unhcr_code: z
    .string()
    .nullable()
    .describe(
      "UNHCR's own code for the asylum country (GFR for Germany), for matching UNHCR publications; origin and asylum take the ISO3 code, not this. Null when summed.",
    ),
  asylum_name: z.string().nullable().describe('Asylum country name. Null when summed.'),
};

/** A nullable count column. */
export const countField = (description: string) =>
  z
    .number()
    .nullable()
    .describe(
      `${description} Null when UNHCR marks it not applicable or not collected — never zero.`,
    );

const dimensionScopeSchema = (dimension: string) =>
  z
    .object({
      mode: z
        .enum(['summed', 'listed', 'each'])
        .describe(
          'summed: every country added into one row; listed: one row per code in codes; each: one row per country (expand).',
        ),
      codes: z.array(z.string()).describe('ISO3 codes sent upstream; empty unless mode is listed.'),
    })
    .describe(`How the ${dimension} dimension was queried.`);

export const appliedScopeSchema = z
  .object({
    origin: dimensionScopeSchema('origin'),
    asylum: dimensionScopeSchema('asylum'),
    year_from: z.number().int().describe('First year sent upstream, after filling and clamping.'),
    year_to: z.number().int().describe('Last year sent upstream, after filling and clamping.'),
    normalized: z
      .array(
        z
          .object({
            input: z.string().describe('The code as given.'),
            iso3: z.string().describe('The ISO3 code it was rewritten to.'),
          })
          .describe('One ISO2 → ISO3 rewrite.'),
      )
      .describe('ISO 3166 alpha-2 codes rewritten to ISO3.'),
  })
  .describe('The scope actually sent upstream, including clamped years and code rewrites.');

export type AppliedScope = z.infer<typeof appliedScopeSchema>;

export const attributionSchema = z
  .object({
    source: z.string().describe('Source to cite: "UNHCR Refugee Population Statistics Database".'),
    license: z.string().describe('Dataset licence (CC BY 4.0).'),
    terms_url: z
      .string()
      .describe("URL of UNHCR's Terms of Use for Datasets, to cite with the figures."),
    providers: z
      .array(z.string())
      .describe('Third-party series in this result (IDMC, UNRWA), whose own conditions may apply.'),
  })
  .describe('Attribution UNHCR requires when these figures are reused.');

export type Attribution = z.infer<typeof attributionSchema>;

export const datasetSchema = z
  .object({
    name: z.string().describe('Dataframe handle (df_XXXXX_XXXXX) for unhcr_dataframe_query.'),
    row_count: z.number().int().describe('Rows staged.'),
    expires_at: z.string().describe('ISO 8601 time the staged table expires.'),
  })
  .describe(
    'Present when the full result was staged as a dataframe; read its columns with unhcr_dataframe_describe, then query it with unhcr_dataframe_query.',
  );

export const footnoteSchema = z
  .object({
    text: z.string().describe("UNHCR's caveat text, verbatim."),
    years: z
      .string()
      .describe('Years the caveat covers, as UNHCR writes them (e.g. "2019 - 2022").'),
    origin_iso3: z
      .string()
      .nullable()
      .describe('ISO3 of the origin country the caveat names; null when it applies to any origin.'),
    asylum_iso3: z
      .string()
      .nullable()
      .describe(
        'ISO3 of the asylum country the caveat names; null when it applies to any asylum country.',
      ),
    population_types: z
      .array(z.string())
      .describe('Population-type codes the caveat applies to (decode with unhcr_list_reference).'),
    rows_matched: z.number().int().describe('Rows of the full result the caveat applies to.'),
  })
  .describe('One UNHCR data caveat that applies to rows of this result.');

/** Output fields every data tool returns, keyed for spreading into `z.object`. */
export const sharedResultFields = {
  total_rows: z
    .number()
    .int()
    .describe(
      'Rows in the full result before the inline cut. When complete is false, the result is built from only the upstream rows fetched before the cap, so rows and summed counts can fall short of the complete result.',
    ),
  complete: z
    .boolean()
    .describe(
      'False when the server row cap stopped the upstream fetch; the notice says how many upstream rows were fetched and how to narrow.',
    ),
  measure: z
    .enum(['stock', 'flow'])
    .describe('stock: people in a situation on 31 December; flow: events during the year.'),
  applied_scope: appliedScopeSchema,
  latest_year: z.number().int().describe('Newest year this dataset publishes.'),
  dataset: datasetSchema.optional(),
  data_notes: z
    .array(z.string())
    .describe('How to read the counts: stock or flow, rounding, the meaning of null, caveats.'),
  attribution: attributionSchema,
};

/** Success-path context shared by the data tools, populated through `ctx.enrich`. */
export const dataEnrichment = {
  notice: z
    .string()
    .optional()
    .describe(
      'Guidance for this result: empty-result hints, year clamps, where the full set was staged, or how to narrow.',
    ),
  truncated: z.boolean().optional().describe('True when rows were cut at limit.'),
  shown: z.number().optional().describe('Rows returned inline.'),
  cap: z.number().optional().describe('The limit that was applied.'),
};

/** Render a row's origin or asylum cell: name plus both codes, or "all (summed)". */
export function countryCell(
  iso3: string | null,
  unhcrCode: string | null,
  name: string | null,
): string {
  if (iso3 === null && unhcrCode === null && name === null) return 'all (summed)';
  return cell(`${name ?? '?'} [${iso3 ?? '—'} · UNHCR ${unhcrCode ?? '—'}]`);
}

/** Origin and asylum cells for one row. */
export function identityCells(row: RowIdentity): [string, string] {
  return [
    countryCell(row.origin_iso3, row.origin_unhcr_code, row.origin_name),
    countryCell(row.asylum_iso3, row.asylum_unhcr_code, row.asylum_name),
  ];
}

/** A year window for prose: "2020–2025", or the one year when both ends match. */
export const yearSpan = (from: number, to: number): string =>
  from === to ? String(from) : `${from}–${to}`;

const describeDimension = (dimension: string, scope: AppliedScope['origin']): string => {
  const codes = scope.codes.length ? ` ${scope.codes.join(', ')}` : '';
  return `${dimension} ${scope.mode}${codes}`;
};

/** Render the shared header lines: scope, coverage, completeness, staging. */
export function renderResultHeader(result: {
  applied_scope: AppliedScope;
  complete: boolean;
  dataset?: { expires_at: string; name: string; row_count: number } | undefined;
  latest_year: number;
  measure: string;
  rows: readonly unknown[];
  total_rows: number;
}): string[] {
  const scope = result.applied_scope;
  const rewrites = scope.normalized.map((rewrite) => `${inline(rewrite.input)} → ${rewrite.iso3}`);
  const lines = [
    `**Scope:** ${describeDimension('origin', scope.origin)} · ${describeDimension('asylum', scope.asylum)} · years ${yearSpan(scope.year_from, scope.year_to)}${rewrites.length ? ` · normalized ${rewrites.join(', ')}` : ''}`,
    `**Measure:** ${result.measure} · **Latest year:** ${result.latest_year} · **Rows:** ${result.rows.length} shown of ${result.total_rows} total · **Complete:** ${result.complete ? 'yes' : 'no — the row cap stopped the fetch'}`,
  ];
  if (result.dataset) {
    lines.push(
      `**Dataset:** ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})`,
    );
  }
  return lines;
}

/** Render matched footnotes, each caveat blockquoted since it is upstream free text. */
export function renderFootnotes(footnotes: readonly MatchedFootnote[], total: number): string[] {
  if (footnotes.length === 0) return [`**Footnotes:** none match (${total} total)`];
  const lines = [`### Footnotes (${footnotes.length} of ${total})`];
  for (const note of footnotes) {
    const where = [
      note.origin_iso3 ? `origin ${inline(note.origin_iso3)}` : 'any origin',
      note.asylum_iso3 ? `asylum ${inline(note.asylum_iso3)}` : 'any asylum',
    ].join(', ');
    lines.push(
      `- **${inline(note.years)}** · ${where} · types ${inline(note.population_types.join(', '))} · ${note.rows_matched} rows matched`,
      '',
      blockquote(note.text),
      '',
    );
  }
  return lines;
}

/** A list of codes for one table cell; an empty list renders as an em dash. */
export function codesCell(codes: readonly string[]): string {
  return codes.length > 0 ? cell(codes.join(', ')) : '—';
}

/**
 * A legend decoding every asylum code the rendered rows carry, one line per
 * code list. Codes are upstream data, so each is flattened for its inline slot.
 */
export function renderAsylumLegend(
  sections: readonly {
    codes: Iterable<string>;
    list: keyof typeof ASYLUM_CODES;
    title: string;
  }[],
): string[] {
  const lines: string[] = [];
  for (const { codes, list, title } of sections) {
    const present = [...new Set(codes)].sort();
    if (present.length === 0) continue;
    const decoded = present.map(
      (code) => `${inline(code)} ${asylumCodeLabel(list, code) ?? '(not in UNHCR’s code list)'}`,
    );
    lines.push(`- **${title}:** ${decoded.join(' · ')}`);
  }
  return lines.length > 0 ? ['**Codes**', ...lines] : [];
}

/** The attribution line UNHCR's terms require wherever its figures are passed on. */
export function renderAttribution(attribution: Attribution): string {
  const providers = attribution.providers.length
    ? ` Includes third-party series: ${attribution.providers.join(', ')}.`
    : '';
  return `Source: ${attribution.source} (${attribution.license}); terms: ${attribution.terms_url}.${providers}`;
}

/** Render data notes and the attribution line that closes every data result. */
export function renderNotesAndAttribution(dataNotes: readonly string[], attribution: Attribution) {
  return [
    '### Data notes',
    ...dataNotes.map((note) => `- ${note}`),
    '',
    renderAttribution(attribution),
  ];
}
