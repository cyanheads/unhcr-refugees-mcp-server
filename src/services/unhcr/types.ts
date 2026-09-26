/**
 * @fileoverview Domain types for the UNHCR Refugee Statistics API client: raw
 * envelope and row shapes as the API returns them, the normalized row and
 * reference shapes the tools consume, and the validated query a dataset
 * request is built from.
 * @module services/unhcr/types
 */

/** Endpoint path segments the request builder accepts. */
export type Endpoint =
  | 'asylum-applications'
  | 'asylum-decisions'
  | 'countries'
  | 'demographics'
  | 'footnotes'
  | 'idmc'
  | 'nowcasting'
  | 'population'
  | 'regions'
  | 'solutions'
  | 'unrwa';

/** A raw upstream row: every value is a number, a numeric string, `"-"`, or free text. */
export type RawRow = Record<string, unknown>;

/** The page envelope every endpoint returns (`total`/`short-url` omitted: never read). */
export interface Envelope {
  items: RawRow[];
  /** Pages available at the requested page size; `0` for an empty result. */
  maxPages: number;
}

/** How a query treats one country dimension. */
export type DimensionMode = 'each' | 'listed' | 'summed';

/** One country dimension of a validated query. */
export interface DimensionScope {
  /** Validated uppercase ISO3 codes; non-empty only when `mode` is `listed`. */
  codes: string[];
  mode: DimensionMode;
}

/** A validated dataset query: both dimensions plus a window inside coverage. */
export interface DatasetQuery {
  asylum: DimensionScope;
  origin: DimensionScope;
  yearFrom: number;
  yearTo: number;
}

/** Identity columns every normalized data row starts with. `null` means summed. */
export interface RowIdentity {
  asylum_iso3: string | null;
  asylum_name: string | null;
  asylum_unhcr_code: string | null;
  origin_iso3: string | null;
  origin_name: string | null;
  origin_unhcr_code: string | null;
  year: number;
}

/** Count columns of `/population/`, in output order. */
export const POPULATION_FIELDS = [
  'refugees',
  'asylum_seekers',
  'oip',
  'idps',
  'stateless',
  'ooc',
  'hst',
  'returned_refugees',
  'returned_idps',
] as const;

/** Count columns of `/solutions/`, in output order. */
export const SOLUTIONS_FIELDS = [
  'returned_refugees',
  'resettlement',
  'naturalisation',
  'returned_idps',
] as const;

/**
 * Count columns of `/demographics/`: seven female and seven male bands (ages
 * 0–4, 5–11, 12–17, 18–59, 60+, unknown age, all ages), then the row total.
 */
export const DEMOGRAPHICS_FIELDS = [
  'f_0_4',
  'f_5_11',
  'f_12_17',
  'f_18_59',
  'f_60',
  'f_other',
  'f_total',
  'm_0_4',
  'm_5_11',
  'm_12_17',
  'm_18_59',
  'm_60',
  'm_other',
  'm_total',
  'total',
] as const;

/** Count column of `/asylum-applications/`. */
export const APPLICATION_FIELDS = ['applied'] as const;

/** Count columns of `/asylum-decisions/`. */
export const DECISION_FIELDS = [
  'dec_recognized',
  'dec_other',
  'dec_rejected',
  'dec_closed',
  'dec_total',
] as const;

export type PopulationField = (typeof POPULATION_FIELDS)[number];
export type SolutionsField = (typeof SOLUTIONS_FIELDS)[number];
export type DemographicsField = (typeof DEMOGRAPHICS_FIELDS)[number];
export type DecisionField = (typeof DECISION_FIELDS)[number];

/** A normalized data row: identity plus the dataset's count columns. */
export type DataRow<F extends string> = RowIdentity & Record<F, number | null>;

export type PopulationRow = DataRow<PopulationField>;
export type SolutionsRow = DataRow<SolutionsField>;

/** A `/demographics/` row, fetched with `ptype_show=true` so each row is one population type. */
export type DemographicsRow = DataRow<DemographicsField> & {
  /** Population-type code (`pop_type`: REF, ASY, IDP, …). */
  population_type: string | null;
};

/**
 * Procedure codes an asylum row is split by, trimmed as upstream sends them.
 * `null` where upstream sends `"-"`.
 */
export interface AsylumCodes {
  /** Who decided or registered the claim (`procedure_type`: G, J, U). */
  authority: string | null;
  /** Level of the procedure (`dec_level`: FI, AR, JR, …). */
  decision_level: string | null;
  /** Counting unit (`app_pc` / `dec_pc`): P persons, C cases. */
  unit: string | null;
}

/** An `/asylum-applications/` row. */
export type AsylumApplicationRow = DataRow<'applied'> &
  AsylumCodes & {
    /** Application stage (`app_type`: N, R, A, …). */
    stage: string | null;
  };

/** An `/asylum-decisions/` row. */
export type AsylumDecisionRow = DataRow<DecisionField> & AsylumCodes;

/** A companion-series row (`/unrwa/`, `/idmc/`): identity plus one total. */
export type CompanionRow = DataRow<'total'>;

/** Result of a dataset method: normalized rows, fetch completeness, and what normalization could not keep. */
export interface DatasetResult<R> {
  /** `false` when the configured row cap stopped the page walk. */
  complete: boolean;
  rows: R[];
  /** Rows left out because they carried no usable year. */
  skippedRows: number;
  /** Upstream values that were neither a number nor `"-"`, reported as null. */
  unexpectedValues: number;
}

/** One `/nowcasting/` row: the current-year snapshot for one asylum scope. */
export interface NowcastRow {
  asylum_iso3: string | null;
  asylum_name: string | null;
  asylum_seekers: number | null;
  asylum_unhcr_code: string | null;
  /** Month name of the snapshot; `null` when UNHCR sent none. */
  month: string | null;
  refugees: number | null;
  /** Provenance label, upstream free text; `null` when UNHCR sent none. */
  source: string | null;
  year: number;
}

/** Result of the nowcast method: normalized rows plus what normalization could not keep. */
export interface NowcastResult {
  rows: NowcastRow[];
  /** Rows left out because they carried no usable year. */
  skippedRows: number;
  /** Upstream values that were neither a number nor `"-"`, reported as null. */
  unexpectedValues: number;
}

/** One entry of UNHCR's `/countries/` table, with trimmed names. */
export interface Country {
  iso2: string | null;
  /** `null` for the few entries UNHCR publishes without an ISO3 code. */
  iso3: string | null;
  majorArea: string | null;
  name: string;
  nameFormal: string | null;
  nameLong: string | null;
  nameOrigin: string | null;
  nameShort: string | null;
  nationality: string | null;
  unhcrCode: string;
  /** UN Statistics Division region (upstream `region`). */
  unsdRegion: string | null;
}

/** One UNHCR regional bureau with the countries it covers. */
export interface UnhcrRegion {
  /** ISO3 codes of the member countries. */
  countries: string[];
  id: number;
  name: string;
}

/** First and latest year a dataset publishes. */
export interface Coverage {
  firstYear: number;
  latestYear: number;
}

/** The month and year of the single current-year nowcast snapshot. */
export interface NowcastPeriod {
  month: string;
  year: number;
}
