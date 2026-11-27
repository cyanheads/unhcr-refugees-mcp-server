/**
 * @fileoverview unhcr_list_reference — decodes the vocabulary the unhcr_*
 * tools key on: countries (ISO3 ↔ ISO2 ↔ UNHCR code ↔ names ↔ regions), UNHCR's
 * regional bureaus, each dataset's coverage years, population-type
 * definitions, and asylum code lists. Countries, regions, and coverage come
 * from the live API (cached 24 h); the rest are static tables.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ASYLUM_CODES, DATASETS, POPULATION_TYPES } from '@/services/unhcr/codes.js';
import { COUNTRY_ALIASES, normalizeName } from '@/services/unhcr/country-aliases.js';
import { footnoteSpan } from '@/services/unhcr/footnote-match.js';
import { reportingPeriods } from '@/services/unhcr/reporting-periods.js';
import type { Country } from '@/services/unhcr/types.js';
import { getUnhcrService, staleReferenceNotices } from '@/services/unhcr/unhcr-api-service.js';
import { blankAsUnset } from '../shared/inputs.js';
import { cell, inline, table } from '../shared/markdown.js';

const TOPICS = ['countries', 'regions', 'coverage', 'population_types', 'asylum_codes'] as const;

/**
 * Strict token match: every query token is a substring of the joined name
 * variants or equals one of the country's codes. No fuzzy fallback.
 */
function matchesQuery(country: Country, tokens: readonly string[]): boolean {
  const names = normalizeName(
    [
      country.name,
      country.nameLong,
      country.nameShort,
      country.nameFormal,
      country.nameOrigin,
      country.nationality,
    ]
      .filter((name) => name !== null)
      .join(' '),
  );
  const codes = new Set(
    [country.iso3, country.iso2, country.unhcrCode].flatMap((code) =>
      code ? [code.toLowerCase()] : [],
    ),
  );
  return tokens.every((token) => names.includes(token) || codes.has(token));
}

/**
 * The countries a query's words match. Initials read as one word first
 * (`U.S.A.`); where that matches nothing, each is its own word, so
 * `F.R. Germany` finds the country whose names hold F, R, and Germany.
 */
function matchCountries<T extends Country>(countries: readonly T[], query: string): T[] {
  const match = (text: string) => {
    const tokens = normalizeName(text).split(' ').filter(Boolean);
    return countries.filter((country) => matchesQuery(country, tokens));
  };
  const joined = match(query);
  return joined.length > 0 ? joined : match(query.normalize('NFKD').replaceAll('.', ' '));
}

const codeSchema = z
  .object({
    code: z.string().describe('The code as it appears in the data.'),
    label: z.string().describe('What the code means.'),
    documented: z
      .boolean()
      .describe(
        "False for codes seen in the data that UNHCR's published methodology does not define.",
      ),
  })
  .describe('One code and its meaning.');

export const listReferenceTool = tool('unhcr_list_reference', {
  title: 'UNHCR reference vocabulary',
  description:
    'Decode the vocabulary the unhcr_* tools take as input: countries (ISO3, ISO2, UNHCR code, names, UNHCR and UN regions), UNHCR’s regional bureaus, each dataset’s first and latest year, population-type definitions, and the asylum authority, stage, decision-level, and unit codes. Filter countries with name_contains to turn a country name into the ISO3 code that origin and asylum take.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        "countries: every queryable country with its codes, names, and regions. regions: UNHCR's regional bureaus. coverage: first and latest year of each dataset, plus the current nowcast month. population_types: what each population type counts and which output column carries it. asylum_codes: asylum authority, application stage, decision level, and unit codes.",
      ),
    name_contains: blankAsUnset(z.string().max(200).optional()).describe(
      'For topic countries only: keep countries whose names, in UNHCR’s English spelling, contain every word given, ignoring case, accents, and punctuation, or whose ISO3, ISO2, or UNHCR code equals a word ("syria", "turkiye", "britain", "deu"). Words match every name variant UNHCR records, including short and formal names the output does not list. Some common English names UNHCR does not use ("turkey", "ivory coast", "uk") return just their country when given alone, with a notice. No fuzzy matching.',
    ),
  }),

  output: z.object({
    topic: z.enum(TOPICS).describe('The topic returned.'),
    countries: z
      .array(
        z
          .object({
            iso3: z.string().describe('ISO 3166-1 alpha-3 code — what origin and asylum take.'),
            iso2: z.string().nullable().describe('ISO 3166-1 alpha-2 code, where one exists.'),
            unhcr_code: z
              .string()
              .describe("UNHCR's own country code, as it appears in data rows."),
            name: z.string().describe("UNHCR's country name."),
            name_long: z.string().nullable().describe('Long-form name, where UNHCR has one.'),
            nationality: z
              .string()
              .nullable()
              .describe('Nationality adjective, where UNHCR has one.'),
            unhcr_region: z
              .string()
              .nullable()
              .describe('UNHCR regional bureau covering the country, where one does.'),
            unsd_region: z
              .string()
              .nullable()
              .describe('UN Statistics Division region, where UNHCR records one.'),
            major_area: z
              .string()
              .nullable()
              .describe('UN Statistics Division major area, where UNHCR records one.'),
          })
          .describe('One queryable country.'),
      )
      .optional()
      .describe('Present for topic countries, sorted by name.'),
    regions: z
      .array(
        z
          .object({
            id: z.number().int().describe("UNHCR's region id."),
            name: z.string().describe('Regional bureau name.'),
            country_count: z.number().int().describe('Countries the bureau covers.'),
          })
          .describe('One UNHCR regional bureau.'),
      )
      .optional()
      .describe('Present for topic regions.'),
    coverage: z
      .array(
        z
          .object({
            dataset: z
              .string()
              .describe(
                'Dataset key: population, demographics, asylum_applications, asylum_decisions, solutions, unrwa, idmc, or footnotes.',
              ),
            tool: z.string().describe('The tool that returns this dataset.'),
            measure: z
              .enum(['stock', 'flow'])
              .nullable()
              .describe('Stock at a point in time or flow during a period; null for footnotes.'),
            latest_reporting_period: z
              .string()
              .nullable()
              .describe('Reporting period for the latest row year, or null for footnotes.'),
            first_year: z.number().int().describe('First year with data.'),
            latest_year: z.number().int().describe('Latest year with data.'),
            note: z.string().describe('What the dataset holds.'),
          })
          .describe("One dataset's published span."),
      )
      .optional()
      .describe('Present for topic coverage.'),
    nowcast: z
      .object({
        year: z.number().int().describe('Year of the current nowcast snapshot.'),
        month: z.string().describe('Month name of the current nowcast snapshot (e.g. "August").'),
      })
      .optional()
      .describe(
        "Present for topic coverage: the single current-year estimate unhcr_get_population's include_nowcast returns.",
      ),
    population_types: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Population-type code (REF, ASY, …), as footnotes and the unhcr_get_demographics population_types filter use it.',
              ),
            field: z
              .string()
              .nullable()
              .describe(
                'Output column carrying the type; null when it is counted inside another column.',
              ),
            label: z.string().describe('Population-type name.'),
            measure: z
              .enum(['stock', 'flow'])
              .describe('Stock at a point in time or flow during a period.'),
            definition: z.string().describe('What the type counts.'),
          })
          .describe('One UNHCR population type.'),
      )
      .optional()
      .describe('Present for topic population_types.'),
    asylum_codes: z
      .object({
        authority: z.array(codeSchema).describe('Who decided the claim.'),
        application_stage: z.array(codeSchema).describe('Stage of an asylum application.'),
        decision_level: z.array(codeSchema).describe('Level at which a decision was made.'),
        unit: z.array(codeSchema).describe('Whether a count is of persons or cases.'),
      })
      .optional()
      .describe('Present for topic asylum_codes.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Stale reference lists used and their ages, or guidance about what name_contains matched or why it was ignored.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe('Countries returned, after any name_contains filter.'),
  },

  errors: [
    {
      reason: 'upstream_busy',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: "Reference data not yet cached (countries, regions, coverage) needs UNHCR requests, and this server's UNHCR request queue cannot start them before the call's deadline, or UNHCR answered 429",
      recovery:
        'Wait the retryAfter seconds the error carries, then call unhcr_list_reference again; reference data is cached after the first success.',
    },
  ],

  async handler(input, ctx) {
    const service = getUnhcrService();
    const query = input.name_contains?.trim() ?? '';
    const notices: string[] = [];
    if (query !== '' && input.topic !== 'countries') {
      notices.push('name_contains applies only to topic countries and was ignored.');
    }

    const finish = <T>(output: T): T => {
      notices.push(...staleReferenceNotices(ctx));
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      return output;
    };

    switch (input.topic) {
      case 'countries': {
        const [{ list, table: countryTable }, { regionByIso3 }] = await Promise.all([
          service.countries(ctx),
          service.regions(ctx),
        ]);
        const name = normalizeName(query);
        const aliasIso3 = COUNTRY_ALIASES.get(name);
        const aliased = aliasIso3 === undefined ? undefined : countryTable.byIso3.get(aliasIso3);
        // A query with no Latin letter or digit leaves no token, and matches nothing rather than everything.
        const matchable = query === '' || name !== '';
        const queryable = list.filter(
          (country): country is Country & { iso3: string } => country.iso3 !== null,
        );
        const matched = aliased
          ? queryable.filter((country) => country === aliased)
          : matchable
            ? matchCountries(queryable, query)
            : [];
        const countries = matched
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((country) => ({
            iso3: country.iso3,
            iso2: country.iso2,
            unhcr_code: country.unhcrCode,
            name: country.name,
            name_long: country.nameLong,
            nationality: country.nationality,
            unhcr_region: regionByIso3.get(country.iso3) ?? null,
            unsd_region: country.unsdRegion,
            major_area: country.majorArea,
          }));
        ctx.enrich.total(countries.length);
        if (aliased) {
          notices.push(
            `Read "${name}" as ${inline(aliased.name)} (ISO3 ${aliased.iso3}), UNHCR's name for the country.`,
          );
        } else if (countries.length === 0) {
          const why = matchable
            ? ''
            : " Names match UNHCR's English spellings and codes match ISO3, ISO2, or UNHCR codes, so name_contains needs Latin letters or digits.";
          notices.push(
            `No country name or code matched "${inline(query)}".${why} Call unhcr_list_reference (topic countries) without name_contains to browse the full list.`,
          );
        }
        return finish({ topic: input.topic, countries });
      }

      case 'regions': {
        const { regions } = await service.regions(ctx);
        return finish({
          topic: input.topic,
          regions: regions.map((region) => ({
            id: region.id,
            name: region.name,
            country_count: region.countries.length,
          })),
        });
      }

      case 'coverage': {
        const [spans, footnotes, nowcast] = await Promise.all([
          Promise.all(
            DATASETS.map(async ({ endpoint }) =>
              endpoint === 'footnotes' ? undefined : service.coverage(endpoint, ctx),
            ),
          ),
          service.footnotes(ctx),
          service.nowcastPeriod(ctx),
        ]);
        const span = footnoteSpan(footnotes);
        const observedAt = Date.now();
        const coverage = DATASETS.flatMap((info, index) => {
          const years =
            info.endpoint === 'footnotes'
              ? span && { firstYear: span[0], latestYear: span[1] }
              : spans[index];
          if (!years) return [];
          return [
            {
              dataset: info.dataset,
              tool: info.tool,
              measure: info.measure,
              first_year: years.firstYear,
              latest_year: years.latestYear,
              latest_reporting_period:
                info.endpoint === 'footnotes'
                  ? null
                  : (reportingPeriods(info.endpoint, [years.latestYear], observedAt)[0] ?? null),
              note: info.note,
            },
          ];
        });
        return finish({ topic: input.topic, coverage, nowcast });
      }

      case 'population_types':
        return finish({
          topic: input.topic,
          population_types: POPULATION_TYPES.map((type) => ({ ...type })),
        });

      case 'asylum_codes':
        return finish({
          topic: input.topic,
          asylum_codes: {
            authority: [...ASYLUM_CODES.authority],
            application_stage: [...ASYLUM_CODES.application_stage],
            decision_level: [...ASYLUM_CODES.decision_level],
            unit: [...ASYLUM_CODES.unit],
          },
        });
    }
  },

  format: (result) => {
    const lines = [`**Topic:** ${result.topic}`, ''];
    const orNone = (value: string | null) => (value === null ? '—' : cell(value));

    if (result.countries) {
      lines.push(
        result.countries.length > 0
          ? table(
              [
                'ISO3',
                'ISO2',
                'UNHCR code',
                'Name',
                'Long name',
                'Nationality',
                'UNHCR region',
                'UN region',
                'Major area',
              ],
              result.countries.map((country) => [
                cell(country.iso3),
                orNone(country.iso2),
                cell(country.unhcr_code),
                cell(country.name),
                orNone(country.name_long),
                orNone(country.nationality),
                orNone(country.unhcr_region),
                orNone(country.unsd_region),
                orNone(country.major_area),
              ]),
            )
          : '_No countries._',
        '',
      );
    }

    if (result.regions) {
      lines.push(
        table(
          ['Id', 'Regional bureau', 'Countries'],
          result.regions.map((region) => [
            String(region.id),
            cell(region.name),
            String(region.country_count),
          ]),
        ),
        '',
      );
    }

    if (result.coverage) {
      lines.push(
        table(
          [
            'Dataset',
            'Tool',
            'Measure',
            'First year',
            'Latest year',
            'Latest reporting period',
            'Note',
          ],
          result.coverage.map((entry) => [
            entry.dataset,
            entry.tool,
            entry.measure ?? '—',
            String(entry.first_year),
            String(entry.latest_year),
            entry.latest_reporting_period === null ? '—' : cell(entry.latest_reporting_period),
            cell(entry.note),
          ]),
        ),
        '',
      );
    }

    if (result.nowcast) {
      lines.push(
        `**Nowcast:** one current-year snapshot, ${inline(result.nowcast.month)} ${result.nowcast.year}.`,
        '',
      );
    }

    if (result.population_types) {
      lines.push(
        table(
          ['Code', 'Label', 'Output field', 'Measure', 'Definition'],
          result.population_types.map((type) => [
            type.code,
            cell(type.label),
            type.field ?? '— (counted inside another column)',
            type.measure,
            cell(type.definition),
          ]),
        ),
        '',
      );
    }

    if (result.asylum_codes) {
      const codes = result.asylum_codes;
      const section = (title: string, list: readonly z.infer<typeof codeSchema>[]) => [
        `### ${title}`,
        table(
          ['Code', 'Label', 'Documented'],
          list.map((entry) => [entry.code, cell(entry.label), entry.documented ? 'yes' : 'no']),
        ),
        '',
      ];
      lines.push(
        ...section('Authority', codes.authority),
        ...section('Application stage', codes.application_stage),
        ...section('Decision level', codes.decision_level),
        ...section('Unit', codes.unit),
      );
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
