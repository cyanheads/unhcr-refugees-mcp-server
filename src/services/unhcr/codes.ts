/**
 * @fileoverview Static vocabulary: population-type definitions, asylum code
 * lists, the datasets this server serves with their coverage probes, and the
 * attribution UNHCR's Terms of Use for Datasets require. Definitions follow
 * UNHCR's Refugee Data Finder methodology ("Definition" and "Data content").
 * @module services/unhcr/codes
 */

import type { Endpoint } from './types.js';

/** Attribution string fixed by §3 of UNHCR's Terms of Use for Datasets. */
export const ATTRIBUTION_SOURCE = 'UNHCR Refugee Population Statistics Database';

/** Licence the datasets are published under. */
export const DATA_LICENSE = 'CC BY 4.0';

/** Terms of Use for Datasets, linked wherever access is facilitated (§4). */
export const TERMS_URL =
  'https://www.unhcr.org/what-we-do/data-and-publications/data-and-statistics/terms-use-datasets';

/** Third-party series UNHCR's API carries; credited in `attribution.providers`. */
export type Provider = 'IDMC' | 'UNRWA';

/** Whether a count is a year-end stock or a within-year flow. */
export type Measure = 'flow' | 'stock';

/** One UNHCR population type and the output column that carries it. */
export interface PopulationType {
  code: string;
  definition: string;
  /** Output column carrying the type, or `null` when it is folded into another. */
  field: string | null;
  label: string;
  measure: Measure;
}

export const POPULATION_TYPES: readonly PopulationType[] = [
  {
    code: 'REF',
    field: 'refugees',
    label: 'Refugees',
    measure: 'stock',
    definition:
      'People recognized under the 1951 Refugee Convention, its 1967 Protocol, the 1969 OAU Convention, the Cartagena Declaration as incorporated into national law, or UNHCR’s Statute, plus people granted complementary forms of protection or temporary protection. Includes people in refugee-like situations. Palestine refugees under UNRWA’s mandate are a separate series.',
  },
  {
    code: 'ROC',
    field: null,
    label: 'People in refugee-like situations',
    measure: 'stock',
    definition:
      'People outside their country or territory of origin who face protection risks similar to refugees but whose refugee status has not been ascertained, for practical or other reasons. Counted inside refugees.',
  },
  {
    code: 'ASY',
    field: 'asylum_seekers',
    label: 'Asylum-seekers',
    measure: 'stock',
    definition:
      'People who have sought international protection and whose claims for refugee status have not yet been determined, whatever stage the claim is at.',
  },
  {
    code: 'OIP',
    field: 'oip',
    label: 'Other people in need of international protection',
    measure: 'stock',
    definition:
      'People outside their country or territory of origin, typically forcibly displaced across international borders, who are not reported under the other categories (asylum-seekers, refugees, people in refugee-like situations) but who likely need international protection, including protection against forced return.',
  },
  {
    code: 'IDP',
    field: 'idps',
    label: 'Internally displaced people',
    measure: 'stock',
    definition:
      'People forced to flee their homes because of armed conflict, generalized violence, or human rights violations who have not crossed an international border, and whom UNHCR protects or assists. Includes people in IDP-like situations since 2007. IDMC’s broader conflict-IDP estimate is a separate series.',
  },
  {
    code: 'IOC',
    field: null,
    label: 'People in IDP-like situations',
    measure: 'stock',
    definition:
      'People inside their own country who face protection risks similar to IDPs but who, for practical or other reasons, could not be reported as such. Counted inside idps.',
  },
  {
    code: 'STA',
    field: 'stateless',
    label: 'Stateless persons',
    measure: 'stock',
    definition:
      'People not considered as nationals by any State under the operation of its law, including people of undetermined nationality. Reported under others of concern until 2003.',
  },
  {
    code: 'OOC',
    field: 'ooc',
    label: 'Others of concern',
    measure: 'stock',
    definition:
      'People who do not fall into the other groups but to whom UNHCR extends protection or assistance on humanitarian or other special grounds.',
  },
  {
    code: 'HST',
    field: 'hst',
    label: 'Host community',
    measure: 'stock',
    definition:
      'A community hosting large populations of refugees or internally displaced people, in camps, within households, or independently, reported where UNHCR runs substantive programmes to share the burden of hosting.',
  },
  {
    code: 'RET',
    field: 'returned_refugees',
    label: 'Returned refugees',
    measure: 'flow',
    definition:
      'Former refugees who returned to their country of origin during the calendar year, recorded against the country they returned from.',
  },
  {
    code: 'RDP',
    field: 'returned_idps',
    label: 'Returned IDPs',
    measure: 'flow',
    definition:
      'IDPs protected or assisted by UNHCR who returned to their areas of origin during the calendar year, recorded against the origin country itself.',
  },
  {
    code: 'RST',
    field: 'resettlement',
    label: 'Resettled refugees',
    measure: 'flow',
    definition:
      'Refugees transferred during the calendar year from an asylum country to a third State that agreed to admit them, recorded against the country they were resettled to.',
  },
  {
    code: 'NAT',
    field: 'naturalisation',
    label: 'Naturalised refugees',
    measure: 'flow',
    definition:
      'Refugees who acquired the nationality of their asylum country during the calendar year. An incomplete proxy for local integration.',
  },
];

/** One code in an asylum code list. */
export interface AsylumCode {
  code: string;
  /** `false` for codes seen in the data that UNHCR's methodology does not define. */
  documented: boolean;
  label: string;
}

const documented = (code: string, label: string): AsylumCode => ({ code, label, documented: true });

/** Asylum-procedure code lists from UNHCR's "Data content" methodology. */
export const ASYLUM_CODES = {
  authority: [documented('G', 'Government'), documented('J', 'Joint'), documented('U', 'UNHCR')],
  application_stage: [
    documented('N', 'New'),
    documented('R', 'Repeat'),
    documented('A', 'Appeal'),
    documented('NA', 'New and appeal (reported together)'),
    documented('NR', 'New and repeat (reported together)'),
    documented('FA', 'First and appeal'),
    documented('J', 'Judiciary'),
    documented('BL', 'Backlog'),
    documented('SP', 'Subsidiary protection'),
    {
      code: 'V',
      label: 'Undocumented stage code (appears 2000–2005 only)',
      documented: false,
    },
    { code: 'RA', label: 'Undocumented stage code (appears 2023 onward)', documented: false },
  ],
  decision_level: [
    documented('NA', 'New applications'),
    documented('FI', 'First instance'),
    documented('AR', 'Administrative review'),
    documented('RA', 'Repeat/reopened'),
    documented('IN', 'US Citizenship and Immigration Services'),
    documented('EO', 'US Executive Office for Immigration Review'),
    documented('JR', 'Judicial review'),
    documented('SP', 'Subsidiary protection'),
    documented('FA', 'First instance and appeal'),
    documented('TP', 'Temporary protection'),
    documented('TA', 'Temporary asylum'),
    documented('BL', 'Backlog'),
    documented('TR', 'Temporary leave to remain'),
    documented('CA', 'Cantonal regulations (Switzerland)'),
  ],
  unit: [documented('P', 'Persons'), documented('C', 'Cases')],
} as const satisfies Record<string, readonly AsylumCode[]>;

/** Application-stage codes the `stages` filter accepts (every code in {@link ASYLUM_CODES}). */
export const APPLICATION_STAGES = [
  'N',
  'R',
  'A',
  'NA',
  'NR',
  'FA',
  'J',
  'BL',
  'SP',
  'V',
  'RA',
] as const satisfies readonly (typeof ASYLUM_CODES.application_stage)[number]['code'][];

/** Decision-level codes the `decision_levels` filter accepts. */
export const DECISION_LEVELS = [
  'NA',
  'FI',
  'AR',
  'RA',
  'IN',
  'EO',
  'JR',
  'SP',
  'FA',
  'TP',
  'TA',
  'BL',
  'TR',
  'CA',
] as const satisfies readonly (typeof ASYLUM_CODES.decision_level)[number]['code'][];

/** The label of an asylum code, or `undefined` for a code the lists do not carry. */
export function asylumCodeLabel(list: keyof typeof ASYLUM_CODES, code: string): string | undefined {
  const entries: readonly AsylumCode[] = ASYLUM_CODES[list];
  return entries.find((entry) => entry.code === code)?.label;
}

/** Datasets whose span the coverage probe measures, keyed by endpoint. */
export type ProbedDataset = Extract<
  Endpoint,
  | 'asylum-applications'
  | 'asylum-decisions'
  | 'demographics'
  | 'idmc'
  | 'population'
  | 'solutions'
  | 'unrwa'
>;

/** A dataset listed by the `coverage` reference topic. */
export interface DatasetInfo {
  /** Dataset key as it appears in `coverage[].dataset`. */
  dataset: string;
  /** Endpoint whose rows give the span; footnote years come from the parsed footnotes. */
  endpoint: ProbedDataset | 'footnotes';
  measure: Measure | null;
  note: string;
  /** The tool that returns the dataset's figures. */
  tool: string;
}

/** Datasets the registered tools serve, in `coverage` listing order. */
export const DATASETS: readonly DatasetInfo[] = [
  {
    dataset: 'population',
    endpoint: 'population',
    tool: 'unhcr_get_population',
    measure: 'stock',
    note: 'Year-end stocks by origin and asylum country; returned_refugees and returned_idps are flows during the year.',
  },
  {
    dataset: 'demographics',
    endpoint: 'demographics',
    tool: 'unhcr_get_demographics',
    measure: 'stock',
    note: 'Year-end stocks by population type, sex, and age band. Coverage is partial, and the totals come from a separate collection that need not match population.',
  },
  {
    dataset: 'asylum_applications',
    endpoint: 'asylum-applications',
    tool: 'unhcr_get_asylum_applications',
    measure: 'flow',
    note: 'Asylum applications lodged during each year, by application stage, authority, decision level, and unit (persons or cases).',
  },
  {
    dataset: 'asylum_decisions',
    endpoint: 'asylum-decisions',
    tool: 'unhcr_get_asylum_decisions',
    measure: 'flow',
    note: 'Asylum decisions during each year by outcome, with the Refugee Recognition Rate and Total Protection Rate over substantive decisions.',
  },
  {
    dataset: 'solutions',
    endpoint: 'solutions',
    tool: 'unhcr_get_solutions',
    measure: 'flow',
    note: 'Returns, resettlement arrivals, and naturalisations during each year.',
  },
  {
    dataset: 'unrwa',
    endpoint: 'unrwa',
    tool: 'unhcr_get_population',
    measure: 'stock',
    note: 'Palestine refugees registered with UNRWA, shown beside population rows as unrwa_refugees.',
  },
  {
    dataset: 'idmc',
    endpoint: 'idmc',
    tool: 'unhcr_get_population',
    measure: 'stock',
    note: 'IDMC’s estimate of people internally displaced by conflict and violence, shown beside population rows as idmc_conflict_idps.',
  },
  {
    dataset: 'footnotes',
    endpoint: 'footnotes',
    tool: 'unhcr_get_population',
    measure: null,
    note: 'UNHCR’s per-country data caveats, attached to unhcr_get_population, unhcr_get_demographics, and unhcr_get_solutions results.',
  },
];

/** Population types `/demographics/` breaks down, in `population_types` filter order. */
export const DEMOGRAPHIC_TYPES = [
  'REF',
  'ASY',
  'OIP',
  'IDP',
  'STA',
  'OOC',
  'HST',
  'RET',
  'RDP',
] as const;

/** Types counted inside another column, which footnotes can still name. */
export const FOLDED_TYPES: Readonly<Record<string, string>> = { REF: 'ROC', IDP: 'IOC' };

/** Population types whose footnotes attach to `unhcr_get_population` rows. */
export const POPULATION_FOOTNOTE_TYPES = [
  'REF',
  'ROC',
  'ASY',
  'OIP',
  'IDP',
  'IOC',
  'STA',
  'OOC',
  'HST',
  'RET',
  'RDP',
] as const;

/** Population types whose footnotes attach to `unhcr_get_solutions` rows. */
export const SOLUTIONS_FOOTNOTE_TYPES = ['RET', 'RST', 'NAT', 'RDP'] as const;
