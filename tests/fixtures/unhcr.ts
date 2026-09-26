/**
 * @fileoverview Recorded-shape fixtures for the UNHCR Refugee Statistics API
 * (`https://api.unhcr.org/population/v1`). Rows, envelopes, and quirks were
 * captured from the live API: summed dimensions carry `"-"` in every identity
 * column, count cells mix integers with the strings `"0"` and `"-"`, names can
 * carry trailing spaces, footnote country columns hold `" "` and blank ISO
 * codes, and footnote text can contain `\r\r\n` line breaks. Values are the
 * published figures except where a comment marks a row as illustrative.
 * @module tests/fixtures/unhcr
 */

/** A raw upstream row. */
export type RawRow = Record<string, unknown>;

interface CountrySpec {
  code: string;
  id: number;
  iso: string | null;
  iso2: string | null;
  majorArea: string | null;
  name: string;
  nameFormal: string | null;
  nameLong: string | null;
  nameOrigin?: string | null;
  nameShort?: string | null;
  nationality: string | null;
  region: string | null;
}

/** A `/countries/` row in the recorded key set (French columns mirror the English ones). */
const country = (spec: CountrySpec): RawRow => ({
  '0': 1,
  id: spec.id,
  code: spec.code,
  iso: spec.iso,
  iso2: spec.iso2,
  name: spec.name,
  nameOrigin: spec.nameOrigin === undefined ? spec.name : spec.nameOrigin,
  nameLong: spec.nameLong,
  nameShort: spec.nameShort === undefined ? spec.name : spec.nameShort,
  nameFormal: spec.nameFormal,
  nationality: spec.nationality,
  majorArea: spec.majorArea,
  region: spec.region,
  nameFr: spec.name,
  majorAreaFr: spec.majorArea,
  regionFr: spec.region,
});

/** `/countries/` rows, including UNHCR codes that differ from ISO3 and three rows with no ISO3. */
export const COUNTRY_ROWS: RawRow[] = [
  country({
    id: 2,
    code: 'AFG',
    iso: 'AFG',
    iso2: 'AF',
    name: 'Afghanistan',
    nameLong: 'Afghanistan',
    nameFormal: 'the Islamic State of Afghanistan',
    nationality: 'Afghan',
    majorArea: 'Asia',
    region: 'Southern Asia',
  }),
  country({
    id: 11,
    code: 'AUL',
    iso: 'AUS',
    iso2: 'AU',
    name: 'Australia',
    nameLong: 'Australia',
    nameFormal: 'Australia',
    nationality: 'Australian',
    majorArea: 'Oceania',
    region: 'Australia-New Zealand',
  }),
  country({
    id: 12,
    code: 'AUS',
    iso: 'AUT',
    iso2: 'AT',
    name: 'Austria',
    nameLong: 'Austria',
    nameFormal: 'the Republic of Austria',
    nationality: 'Austrian',
    majorArea: 'Europe',
    region: 'Western Europe',
  }),
  country({
    id: 254,
    code: 'CUW',
    iso: 'CUW',
    iso2: 'CW',
    name: 'Curacao ',
    nameLong: 'Curacao',
    nameFormal: '',
    nationality: '',
    majorArea: 'Latin America and the Caribbean',
    region: 'Caribbean',
  }),
  country({
    id: 8,
    code: 'ARE',
    iso: 'EGY',
    iso2: 'EG',
    name: 'Egypt',
    nameLong: 'Egypt',
    nameFormal: 'the Arab Republic of Egypt',
    nationality: 'Egyptian',
    majorArea: 'Africa',
    region: 'Northern Africa',
  }),
  country({
    id: 72,
    code: 'GFR',
    iso: 'DEU',
    iso2: 'DE',
    name: 'Germany',
    nameLong: 'Germany',
    nameFormal: 'the Federal Republic of Germany',
    nationality: 'German',
    majorArea: 'Europe',
    region: 'Western Europe',
  }),
  country({
    id: 92,
    code: 'IRQ',
    iso: 'IRQ',
    iso2: 'IQ',
    name: 'Iraq',
    nameLong: 'Iraq',
    nameFormal: 'the Republic of Iraq',
    nationality: 'Iraqi',
    majorArea: 'Asia',
    region: 'Western Asia',
  }),
  country({
    id: 97,
    code: 'JPN',
    iso: 'JPN',
    iso2: 'JP',
    name: 'Japan',
    nameLong: 'Japan',
    nameFormal: 'Japan',
    nationality: 'Japanese',
    majorArea: 'Asia',
    region: 'Eastern Asia',
  }),
  country({
    id: 96,
    code: 'JOR',
    iso: 'JOR',
    iso2: 'JO',
    name: 'Jordan',
    nameLong: 'Jordan',
    nameFormal: 'the Hashemite Kingdom of Jordan',
    nationality: 'Jordanian',
    majorArea: 'Asia',
    region: 'Western Asia',
  }),
  country({
    id: 109,
    code: 'LEB',
    iso: 'LBN',
    iso2: 'LB',
    name: 'Lebanon',
    nameLong: 'Lebanon',
    nameFormal: 'the Lebanese Republic',
    nationality: 'Lebanese',
    majorArea: 'Asia',
    region: 'Western Asia',
  }),
  country({
    id: 118,
    code: 'MAR',
    iso: 'MTQ',
    iso2: 'MQ',
    name: 'Martinique',
    nameLong: 'Martinique',
    nameFormal: '',
    nationality: '',
    majorArea: 'Latin America and the Caribbean',
    region: 'Caribbean',
  }),
  country({
    id: 130,
    code: 'MOR',
    iso: 'MAR',
    iso2: 'MA',
    name: 'Morocco',
    nameLong: 'Morocco',
    nameFormal: 'the Kingdom of Morocco',
    nationality: 'Moroccan',
    majorArea: 'Africa',
    region: 'Northern Africa',
  }),
  country({
    id: 69,
    code: 'GAZ',
    iso: 'PSE',
    iso2: 'PS',
    name: 'State of Palestine',
    nameOrigin: 'Palestinian',
    nameLong: 'State of Palestine',
    nameFormal: 'State of Palestine',
    nationality: 'Palestinians',
    majorArea: 'Asia',
    region: 'Western Asia',
  }),
  country({
    id: 216,
    code: 'STA',
    iso: 'XXA',
    iso2: null,
    name: 'Stateless',
    nameLong: '',
    nameFormal: '',
    nationality: '',
    majorArea: 'Stateless',
    region: 'Stateless',
  }),
  country({
    id: 185,
    code: 'SYR',
    iso: 'SYR',
    iso2: 'SY',
    name: 'Syrian Arab Rep.',
    nameLong: 'Syrian Arab Republic',
    nameFormal: 'the Syrian Arab Republic',
    nationality: 'Syrian',
    majorArea: 'Asia',
    region: 'Western Asia',
  }),
  country({
    id: 218,
    code: 'TIB',
    iso: 'TIB',
    iso2: null,
    name: 'Tibetan',
    nameShort: 'Tibet',
    nameLong: '',
    nameFormal: '',
    nationality: '',
    majorArea: 'Asia',
    region: 'Various',
  }),
  country({
    id: 196,
    code: 'TUR',
    iso: 'TUR',
    iso2: 'TR',
    name: 'Türkiye',
    nameLong: 'Türkiye',
    nameFormal: 'the Republic of Türkiye',
    nationality: 'Turkish',
    majorArea: 'Asia',
    region: 'Western Asia',
  }),
  country({
    id: 200,
    code: 'UKR',
    iso: 'UKR',
    iso2: 'UA',
    name: 'Ukraine',
    nameLong: 'Ukraine',
    nameFormal: 'Ukraine',
    nationality: 'Ukrainian',
    majorArea: 'Europe',
    region: 'Eastern Europe',
  }),
  country({
    id: 70,
    code: 'GBR',
    iso: 'GBR',
    iso2: 'GB',
    name: 'United Kingdom of Great Britain and Northern Ireland',
    nameLong: 'United Kingdom',
    nameFormal: 'the United Kingdom of Great Britain and Northern Ireland',
    nationality: 'of the United Kingdom (of Great Britain and Northern Ireland)',
    majorArea: 'Europe',
    region: 'Northern Europe',
  }),
  country({
    id: 262,
    code: 'UKN',
    iso: 'UNK',
    iso2: 'UK',
    name: 'Unknown ',
    nameLong: null,
    nameShort: null,
    nameFormal: null,
    nationality: null,
    majorArea: null,
    region: null,
  }),
  country({
    id: 290,
    code: 'CRB',
    iso: null,
    iso2: null,
    name: 'CRB',
    nameOrigin: null,
    nameLong: null,
    nameShort: null,
    nameFormal: null,
    nationality: null,
    majorArea: null,
    region: null,
  }),
  country({
    id: 245,
    code: 'SGS',
    iso: null,
    iso2: null,
    name: 'South Georgia and the South Sandwich Islands',
    nameOrigin: null,
    nameLong: '',
    nameFormal: '',
    nationality: '',
    majorArea: null,
    region: null,
  }),
];

/**
 * The recorded `/countries/` row for the United States. Kept out of
 * {@link COUNTRY_ROWS} (whose size the reference tests pin); a test that
 * queries the US asylum series adds it to the served country table.
 */
export const USA_COUNTRY_ROW: RawRow = country({
  id: 202,
  code: 'USA',
  iso: 'USA',
  iso2: 'US',
  name: 'United States of America',
  nameLong: 'United States',
  nameFormal: 'the United States of America',
  nationality: 'of the United States (of America)',
  majorArea: 'Northern America',
  region: 'Northern America',
});

/** `/regions/` rows, verbatim: six bureaus, ids 1, 2, 3, 5, 6, 7. */
export const REGION_ROWS: RawRow[] = [
  { '0': 1, id: 5, name: 'Asia and the Pacific', name_fr: 'Asie et Pacifique' },
  { '0': 1, id: 3, name: 'Eastern and Southern Africa', name_fr: "Afrique de l'Est" },
  { '0': 1, id: 7, name: 'Europe', name_fr: 'Europe' },
  { '0': 1, id: 1, name: 'Middle East and North Africa', name_fr: 'Moyen-Orient' },
  { '0': 1, id: 6, name: 'The Americas', name_fr: 'Amériques' },
  { '0': 1, id: 2, name: 'West and Central Africa', name_fr: "Afrique de l'Ouest" },
];

const countryByIso = (iso: string): RawRow => {
  const row = [...COUNTRY_ROWS, USA_COUNTRY_ROW].find((candidate) => candidate.iso === iso);
  if (!row) throw new Error(`No country fixture for ${iso}`);
  return row;
};

/** `/countries/?unhcr_region=<id>` members, as ISO3 codes (the rows served are country rows). */
export const REGION_MEMBERS: Record<number, string[]> = {
  1: ['EGY', 'IRQ', 'JOR', 'LBN', 'MAR', 'PSE', 'SYR'],
  2: [],
  3: [],
  5: ['AFG', 'AUS', 'JPN'],
  6: ['CUW', 'MTQ'],
  7: ['AUT', 'DEU', 'GBR', 'TUR', 'UKR'],
};

/** Member rows per region id, served for `/countries/?unhcr_region=<id>`. */
export const REGION_MEMBER_ROWS: Record<number, RawRow[]> = Object.fromEntries(
  Object.entries(REGION_MEMBERS).map(([id, isos]) => [Number(id), isos.map(countryByIso)]),
);

/**
 * Identity columns as UNHCR sends them: a named dimension carries its id,
 * name, UNHCR code, and ISO3; a summed one carries `"-"` in all four.
 */
function identity(coo: string | null, coa: string | null): RawRow {
  const side = (prefix: 'coa' | 'coo', iso: string | null): RawRow => {
    if (iso === null) {
      return {
        [`${prefix}_id`]: '-',
        [`${prefix}_name`]: '-',
        [prefix]: '-',
        [`${prefix}_iso`]: '-',
      };
    }
    const row = countryByIso(iso);
    return {
      [`${prefix}_id`]: row.id,
      [`${prefix}_name`]: row.name,
      [prefix]: row.code,
      [`${prefix}_iso`]: iso,
    };
  };
  return { ...side('coo', coo), ...side('coa', coa) };
}

type Cell = number | string;

/** `/population/` value columns in the order the API sends them. */
const POPULATION_COLUMNS = [
  'refugees',
  'asylum_seekers',
  'returned_refugees',
  'idps',
  'returned_idps',
  'stateless',
  'ooc',
  'oip',
  'hst',
] as const;

/** A `/population/` row; `values` follow {@link POPULATION_COLUMNS}. */
export const populationRow = (
  year: number,
  coo: string | null,
  coa: string | null,
  values: readonly Cell[],
): RawRow => ({
  year,
  ...identity(coo, coa),
  ...Object.fromEntries(POPULATION_COLUMNS.map((column, i) => [column, values[i]])),
});

/** A `/solutions/` row: returned_refugees, resettlement, naturalisation, returned_idps. */
export const solutionsRow = (
  year: number,
  coo: string | null,
  coa: string | null,
  [returned_refugees, resettlement, naturalisation, returned_idps]: readonly Cell[],
): RawRow => ({
  year,
  ...identity(coo, coa),
  returned_refugees,
  resettlement,
  naturalisation,
  returned_idps,
});

/** A companion-series row (`/unrwa/`, `/idmc/`). */
export const companionRow = (
  year: number,
  coo: string | null,
  coa: string | null,
  total: Cell,
): RawRow => ({ year, ...identity(coo, coa), total });

/** `/population/` rows: world totals, origin and asylum totals, and Syrian pairs. */
export const POPULATION_ROWS: RawRow[] = [
  populationRow(1951, null, null, [2116011, '0', '0', '0', '0', '0', '0', '-', '0']),
  populationRow(
    2023,
    null,
    null,
    [31637408, 6858500, 1126551, 63251367, 5092064, 4358195, 5945550, 5755363, 26095474],
  ),
  populationRow(
    2024,
    null,
    null,
    [30958200, 8352712, 1615821, 68131711, 8219597, 4360087, 3820662, 5875359, 27279257],
  ),
  populationRow(
    2025,
    null,
    null,
    [28461306, 8998097, 4362272, 64239352, 10308567, 4477220, 2957025, 7177473, 26670162],
  ),
  populationRow(2023, 'SYR', null, [
    6355788,
    182954,
    37552,
    7248188,
    155325,
    '0',
    6626,
    '-',
    16041461,
  ]),
  populationRow(2024, 'SYR', null, [
    5952174,
    167334,
    512718,
    7408909,
    513896,
    '0',
    3416,
    '-',
    16471143,
  ]),
  populationRow(2025, 'SYR', null, [
    4865764,
    154355,
    1341148,
    5542227,
    1964201,
    '0',
    5940,
    '-',
    16504958,
  ]),
  populationRow(2023, 'AFG', null, [
    6403144,
    296033,
    57530,
    3222397,
    31605,
    '0',
    34534,
    '-',
    1584157,
  ]),
  populationRow(2024, 'AFG', null, [
    5766586,
    384732,
    364443,
    3199710,
    22687,
    '0',
    871521,
    '-',
    600000,
  ]),
  populationRow(2025, 'AFG', null, [
    2671560,
    270007,
    1947183,
    3199023,
    8056,
    '0',
    1008969,
    1030958,
    600000,
  ]),
  populationRow(2023, null, 'JOR', [684066, 39775, 4453, '0', '0', 68, 1293, '-', '0']),
  populationRow(2024, null, 'JOR', [643641, 31747, 65382, '0', '0', 17, 1209, '-', '0']),
  populationRow(2025, null, 'JOR', [436226, 8068, 256854, '0', '0', 13, 954, '-', '0']),
  populationRow(2023, 'SYR', 'DEU', [705812, 72642, '0', '0', '0', '0', '0', '-', '0']),
  populationRow(2023, 'SYR', 'JOR', [649091, '0', 4383, '0', '0', '0', '0', '-', '0']),
  populationRow(2023, 'SYR', 'LBN', [784884, '0', 10130, '0', '0', '0', 3026, '-', '0']),
  populationRow(2023, 'SYR', 'SYR', ['0', '0', '0', 7248188, 155325, '0', '0', '-', 16041461]),
  populationRow(2023, 'SYR', 'TUR', [3214780, '0', 19865, '0', '0', '0', '0', '-', '0']),
  populationRow(2024, 'SYR', 'DEU', [725102, 62959, '0', '0', '0', '0', '0', '-', '0']),
  populationRow(2024, 'SYR', 'JOR', [611473, '0', 65268, '0', '0', '0', '0', '-', '0']),
  populationRow(2024, 'SYR', 'LBN', [755426, '0', 254651, '0', '0', '0', 3209, '-', '0']),
  populationRow(2024, 'SYR', 'SYR', ['0', '0', '0', 7408909, 513896, '0', '0', '-', 16471143]),
  populationRow(2024, 'SYR', 'TUR', [2901478, '0', 159439, '0', '0', '0', '0', '-', '0']),
  populationRow(2025, 'SYR', 'DEU', [668647, 65511, '0', '0', '0', '0', '0', '-', '0']),
  populationRow(2025, 'SYR', 'JOR', [420835, '0', 256748, '0', '0', '0', '0', '-', '0']),
  populationRow(2025, 'SYR', 'LBN', [532357, '0', 465578, '0', '0', '0', 2172, '-', '0']),
  populationRow(2025, 'SYR', 'SYR', ['0', '0', '0', 5542227, 1964201, '0', '0', '-', 16504958]),
  populationRow(2025, 'SYR', 'TUR', [2347756, '0', 556009, '0', '0', '0', '0', '-', '0']),
];

/** `/solutions/` rows: world totals (1959 onward) and Syrian origin rows. */
export const SOLUTIONS_ROWS: RawRow[] = [
  solutionsRow(1959, null, null, ['-', 3043, '-', '-']),
  solutionsRow(2023, null, null, [1126551, 158591, 30655, 5092064]),
  solutionsRow(2024, null, null, [1615821, 188759, 88675, 8219597]),
  solutionsRow(2025, null, null, [4362272, 81766, 93296, 10308567]),
  solutionsRow(2023, 'SYR', null, [37552, 33388, 8890, 155325]),
  solutionsRow(2024, 'SYR', null, [512718, 25532, 17595, 513896]),
  solutionsRow(2025, 'SYR', null, [1341148, 8714, 14676, 1964201]),
  solutionsRow(2023, 'SYR', 'JOR', [4383, '-', 25, '-']),
  solutionsRow(2023, 'SYR', 'LBN', [10130, '-', '-', '-']),
  solutionsRow(2023, 'SYR', 'TUR', [19865, '-', '-', '-']),
  solutionsRow(2023, 'SYR', 'DEU', ['-', 3279, '-', '-']),
  solutionsRow(2023, 'SYR', 'SYR', ['-', '-', '-', 155325]),
  solutionsRow(2024, 'SYR', 'JOR', [65268, '-', '-', '-']),
  solutionsRow(2024, 'SYR', 'LBN', [254651, '-', '-', '-']),
  solutionsRow(2024, 'SYR', 'TUR', [159439, '-', '-', '-']),
  solutionsRow(2024, 'SYR', 'DEU', ['-', 2907, '-', '-']),
  solutionsRow(2024, 'SYR', 'SYR', ['-', '-', '-', 513896]),
  solutionsRow(2025, 'SYR', 'JOR', [256748, '-', '-', '-']),
  solutionsRow(2025, 'SYR', 'LBN', [465578, '-', '-', '-']),
  solutionsRow(2025, 'SYR', 'TUR', [556009, '-', '-', '-']),
  solutionsRow(2025, 'SYR', 'DEU', ['-', 209, '-', '-']),
  solutionsRow(2025, 'SYR', 'SYR', ['-', '-', '-', 1964201]),
];

/** `/unrwa/` rows: world totals (1952 onward) and Jordan as asylum. */
export const UNRWA_ROWS: RawRow[] = [
  companionRow(1952, null, null, 394811),
  companionRow(2023, null, null, 5968636),
  companionRow(2024, null, null, 5914401),
  companionRow(2025, null, null, 5964782),
  companionRow(2023, null, 'JOR', 2392531),
  companionRow(2024, null, 'JOR', 2371387),
  companionRow(2025, null, 'JOR', 2398179),
];

/** `/idmc/` rows: world totals (1990 onward) and Syria as origin. */
export const IDMC_ROWS: RawRow[] = [
  companionRow(1990, null, null, 21300000),
  companionRow(2023, null, null, 67332380),
  companionRow(2024, null, null, 73573201),
  companionRow(2025, null, null, 68653080),
  companionRow(2023, 'SYR', null, 7248000),
  companionRow(2024, 'SYR', null, 7409000),
  companionRow(2025, 'SYR', null, 5964000),
];

/** `/nowcasting/` rows: the world snapshot and three asylum countries, August 2026. */
export const NOWCAST_ROWS: RawRow[] = [
  {
    year: 2026,
    ...identity(null, null),
    refugees: 28301919,
    asylum_seekers: 8917756,
    source: 'Nowcasting data',
    month: 'August',
  },
  {
    year: 2026,
    ...identity(null, 'DEU'),
    refugees: 2652400,
    asylum_seekers: 231213,
    source: 'Government',
    month: 'August',
  },
  {
    year: 2026,
    ...identity(null, 'JOR'),
    refugees: 345321,
    asylum_seekers: 7647,
    source: 'UNHCR operational data',
    month: 'August',
  },
  {
    year: 2026,
    ...identity(null, 'TUR'),
    refugees: 2257058,
    asylum_seekers: 102497,
    source: 'Government, UNHCR official statistics, UNHCR operational data',
    month: 'August',
  },
];

/**
 * An `/asylum-applications/` row: authority (`procedure_type`), stage
 * (`app_type`), decision level (`dec_level`), unit (`app_pc`), then `applied`.
 */
export const applicationRow = (
  year: number,
  coo: string | null,
  coa: string | null,
  [procedure_type, app_type, dec_level, app_pc, applied]: readonly [
    string,
    string,
    string,
    string,
    Cell,
  ],
): RawRow => ({
  year,
  ...identity(coo, coa),
  procedure_type,
  app_type,
  dec_level,
  app_pc,
  applied,
});

/**
 * An `/asylum-decisions/` row: authority, decision level, and unit (`dec_pc`),
 * then recognized, other (complementary protection), rejected, closed, total.
 */
export const decisionRow = (
  year: number,
  coo: string | null,
  coa: string | null,
  [procedure_type, dec_level, dec_pc]: readonly [string, string, string],
  [dec_recognized, dec_other, dec_rejected, dec_closed, dec_total]: readonly Cell[],
): RawRow => ({
  year,
  ...identity(coo, coa),
  procedure_type,
  dec_level,
  dec_pc,
  dec_recognized,
  dec_other,
  dec_rejected,
  dec_closed,
  dec_total,
});

/** Upstream band suffixes, in the order `/demographics/` sends them. */
const BAND_SUFFIXES = ['0_4', '5_11', '12_17', '18_59', '60', 'other', 'total'] as const;

/** Sex bands of one demographics row: ages 0–4, 5–11, 12–17, 18–59, 60+, unknown, all. */
export interface DemographicBands {
  f: readonly Cell[];
  m: readonly Cell[];
}

const ZERO_BANDS = ['0', '0', '0', '0', '0', '0', '0'] as const;

/** What UNHCR publishes for a row it has no breakdown for: `"0"` in all fourteen bands. */
export const NO_BREAKDOWN: DemographicBands = { f: ZERO_BANDS, m: ZERO_BANDS };

/** A `/demographics/` row as `ptype_show=true` returns it: one population type per row. */
export const demographicsRow = (
  year: number,
  coo: string | null,
  coa: string | null,
  popType: string,
  total: Cell,
  bands: DemographicBands,
): RawRow => ({
  year,
  ...identity(coo, coa),
  pop_type: popType,
  ...Object.fromEntries(BAND_SUFFIXES.map((suffix, i) => [`f_${suffix}`, bands.f[i]])),
  ...Object.fromEntries(BAND_SUFFIXES.map((suffix, i) => [`m_${suffix}`, bands.m[i]])),
  total,
});

/**
 * `/asylum-applications/` rows. The US series is the multi-unit one the design
 * cites: each year carries person-counted EOIR rows beside case-counted USCIS
 * rows. World and Syrian-origin 2025 also mix the two units within the year.
 */
export const ASYLUM_APPLICATION_ROWS: RawRow[] = [
  // World, first row of 2000 (the dataset's first year)
  applicationRow(2000, null, null, ['G', 'V', 'FI', 'C', 109482]),
  // World 2024, every row
  applicationRow(2024, null, null, ['U', 'N', 'FI', 'P', 484057]),
  applicationRow(2024, null, null, ['G', 'N', 'FI', 'P', 1709842]),
  applicationRow(2024, null, null, ['G', 'A', 'AR', 'P', 147590]),
  applicationRow(2024, null, null, ['G', 'N', 'FA', 'P', 96742]),
  applicationRow(2024, null, null, ['G', 'R', 'RA', 'P', 50659]),
  applicationRow(2024, null, null, ['G', 'A', 'JR', 'P', 129003]),
  applicationRow(2024, null, null, ['G', 'J', 'JR', 'P', 71]),
  applicationRow(2024, null, null, ['G', 'NR', 'FA', 'P', 19308]),
  applicationRow(2024, null, null, ['G', 'R', 'FI', 'P', 8252]),
  applicationRow(2024, null, null, ['G', 'RA', 'RA', 'P', 23687]),
  applicationRow(2024, null, null, ['U', 'A', 'AR', 'P', 4821]),
  applicationRow(2024, null, null, ['G', 'R', 'AR', 'P', 3268]),
  applicationRow(2024, null, null, ['G', 'A', 'FI', 'P', 1440]),
  applicationRow(2024, null, null, ['G', 'N', 'TA', 'P', 6875]),
  applicationRow(2024, null, null, ['U', 'R', 'RA', 'P', 2481]),
  applicationRow(2024, null, null, ['G', 'N', 'EO', 'P', 436517]),
  applicationRow(2024, null, null, ['G', 'N', 'IN', 'P', 292588]),
  applicationRow(2024, null, null, ['G', 'N', 'AR', 'P', 1288]),
  applicationRow(2024, null, null, ['J', 'N', 'FI', 'P', 3098]),
  applicationRow(2024, null, null, ['U', 'A', 'FI', 'P', 56]),
  applicationRow(2024, null, null, ['U', 'R', 'FI', 'P', 133]),
  // World 2025, every row: persons and cases within one year
  applicationRow(2025, null, null, ['G', 'N', 'FI', 'P', 1294468]),
  applicationRow(2025, null, null, ['U', 'N', 'FI', 'P', 323940]),
  applicationRow(2025, null, null, ['G', 'A', 'AR', 'C', 82273]),
  applicationRow(2025, null, null, ['G', 'NR', 'FA', 'P', 58274]),
  applicationRow(2025, null, null, ['G', 'N', 'FA', 'P', 137858]),
  applicationRow(2025, null, null, ['G', 'R', 'RA', 'P', 87064]),
  applicationRow(2025, null, null, ['G', 'A', 'JR', 'P', 187095]),
  applicationRow(2025, null, null, ['G', 'A', 'AR', 'P', 138128]),
  applicationRow(2025, null, null, ['G', 'R', 'FI', 'P', 8032]),
  applicationRow(2025, null, null, ['G', 'RA', 'RA', 'P', 33929]),
  applicationRow(2025, null, null, ['U', 'A', 'AR', 'P', 2842]),
  applicationRow(2025, null, null, ['G', 'N', 'FI', 'C', 8964]),
  applicationRow(2025, null, null, ['G', 'N', 'TA', 'P', 8218]),
  applicationRow(2025, null, null, ['G', 'RA', 'FI', 'P', 272]),
  applicationRow(2025, null, null, ['G', 'N', 'EO', 'P', 629358]),
  applicationRow(2025, null, null, ['G', 'J', 'JR', 'P', 62]),
  applicationRow(2025, null, null, ['U', 'R', 'RA', 'P', 229]),
  applicationRow(2025, null, null, ['G', 'N', 'AR', 'P', 808]),
  applicationRow(2025, null, null, ['J', 'N', 'FI', 'P', 1960]),
  applicationRow(2025, null, null, ['U', 'A', 'FI', 'P', 20]),
  applicationRow(2025, null, null, ['G', 'N', 'NA', 'P', 50148]),
  applicationRow(2025, null, null, ['U', 'R', 'FI', 'P', 154]),
  applicationRow(2025, null, null, ['G', 'A', 'JR', 'C', 6500]),
  applicationRow(2025, null, null, ['G', 'N', 'JR', 'P', 13]),
  applicationRow(2025, null, null, ['G', 'N', 'IN', 'C', 282594]),
  // Asylum USA, 2015–2016: EOIR persons beside USCIS cases in each year
  applicationRow(2015, null, 'USA', ['G', 'N', 'EO', 'P', 45394]),
  applicationRow(2015, null, 'USA', ['G', 'N', 'IN', 'C', 90582]),
  applicationRow(2016, null, 'USA', ['G', 'N', 'EO', 'P', 80567]),
  applicationRow(2016, null, 'USA', ['G', 'N', 'IN', 'C', 124234]),
  // Origin SYR, every asylum country summed, 2024–2025
  applicationRow(2024, 'SYR', null, ['G', 'N', 'FI', 'P', 136414]),
  applicationRow(2024, 'SYR', null, ['U', 'N', 'FI', 'P', 544]),
  applicationRow(2024, 'SYR', null, ['G', 'A', 'AR', 'P', 1793]),
  applicationRow(2024, 'SYR', null, ['G', 'N', 'FA', 'P', 17555]),
  applicationRow(2024, 'SYR', null, ['G', 'R', 'RA', 'P', 4832]),
  applicationRow(2024, 'SYR', null, ['G', 'A', 'JR', 'P', 10964]),
  applicationRow(2024, 'SYR', null, ['G', 'NR', 'FA', 'P', 7651]),
  applicationRow(2024, 'SYR', null, ['G', 'R', 'FI', 'P', 97]),
  applicationRow(2024, 'SYR', null, ['J', 'N', 'FI', 'P', 71]),
  applicationRow(2024, 'SYR', null, ['G', 'RA', 'RA', 'P', 159]),
  applicationRow(2024, 'SYR', null, ['G', 'R', 'AR', 'P', 114]),
  applicationRow(2024, 'SYR', null, ['G', 'N', 'TA', 'P', 726]),
  applicationRow(2024, 'SYR', null, ['G', 'J', 'JR', 'P', 5]),
  applicationRow(2024, 'SYR', null, ['G', 'N', 'EO', 'P', 318]),
  applicationRow(2024, 'SYR', null, ['G', 'N', 'IN', 'P', 164]),
  applicationRow(2025, 'SYR', null, ['G', 'N', 'FI', 'P', 40422]),
  applicationRow(2025, 'SYR', null, ['U', 'N', 'FI', 'P', 554]),
  applicationRow(2025, 'SYR', null, ['G', 'A', 'AR', 'C', 5]),
  applicationRow(2025, 'SYR', null, ['G', 'NR', 'FA', 'P', 1220]),
  applicationRow(2025, 'SYR', null, ['G', 'N', 'FA', 'P', 4656]),
  applicationRow(2025, 'SYR', null, ['G', 'R', 'RA', 'P', 2106]),
  applicationRow(2025, 'SYR', null, ['G', 'A', 'JR', 'P', 17681]),
  applicationRow(2025, 'SYR', null, ['G', 'A', 'AR', 'P', 1398]),
  applicationRow(2025, 'SYR', null, ['G', 'N', 'FI', 'C', 9]),
  applicationRow(2025, 'SYR', null, ['G', 'R', 'FI', 'P', 252]),
  applicationRow(2025, 'SYR', null, ['G', 'RA', 'RA', 'P', 245]),
  applicationRow(2025, 'SYR', null, ['G', 'N', 'TA', 'P', 3196]),
  applicationRow(2025, 'SYR', null, ['G', 'RA', 'FI', 'P', 14]),
  applicationRow(2025, 'SYR', null, ['G', 'J', 'JR', 'P', 5]),
  applicationRow(2025, 'SYR', null, ['G', 'N', 'EO', 'P', 251]),
  // Origin SYR by asylum country, 2024–2025 (the fixture countries plus the US)
  applicationRow(2024, 'SYR', 'AUS', ['G', 'A', 'AR', 'P', 22]),
  applicationRow(2024, 'SYR', 'AUT', ['G', 'N', 'FA', 'P', 13214]),
  applicationRow(2024, 'SYR', 'AUT', ['G', 'R', 'RA', 'P', 695]),
  applicationRow(2024, 'SYR', 'GBR', ['G', 'N', 'FI', 'P', 6680]),
  applicationRow(2024, 'SYR', 'GBR', ['G', 'R', 'RA', 'P', 67]),
  applicationRow(2024, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', 76765]),
  applicationRow(2024, 'SYR', 'DEU', ['G', 'A', 'JR', 'P', 10488]),
  applicationRow(2024, 'SYR', 'DEU', ['G', 'R', 'RA', 'P', 2668]),
  applicationRow(2024, 'SYR', 'MAR', ['U', 'N', 'FI', 'P', 5]),
  applicationRow(2024, 'SYR', 'UKR', ['G', 'N', 'FI', 'P', 5]),
  applicationRow(2024, 'SYR', 'UKR', ['G', 'J', 'JR', 'P', 5]),
  applicationRow(2024, 'SYR', 'USA', ['G', 'A', 'AR', 'P', 20]),
  applicationRow(2024, 'SYR', 'USA', ['G', 'N', 'EO', 'P', 318]),
  applicationRow(2024, 'SYR', 'USA', ['G', 'N', 'IN', 'P', 164]),
  applicationRow(2025, 'SYR', 'AUS', ['G', 'A', 'AR', 'C', 5]),
  applicationRow(2025, 'SYR', 'AUS', ['G', 'NR', 'FA', 'P', 84]),
  applicationRow(2025, 'SYR', 'AUT', ['G', 'N', 'FA', 'P', 4385]),
  applicationRow(2025, 'SYR', 'AUT', ['G', 'R', 'RA', 'P', 96]),
  applicationRow(2025, 'SYR', 'GBR', ['G', 'N', 'FI', 'P', 1959]),
  applicationRow(2025, 'SYR', 'GBR', ['G', 'R', 'RA', 'P', 72]),
  applicationRow(2025, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', 23256]),
  applicationRow(2025, 'SYR', 'DEU', ['G', 'A', 'JR', 'P', 17026]),
  applicationRow(2025, 'SYR', 'DEU', ['G', 'R', 'RA', 'P', 984]),
  applicationRow(2025, 'SYR', 'JPN', ['G', 'N', 'FI', 'P', 35]),
  applicationRow(2025, 'SYR', 'MAR', ['U', 'N', 'FI', 'P', 58]),
  applicationRow(2025, 'SYR', 'UKR', ['G', 'J', 'JR', 'P', 5]),
  applicationRow(2025, 'SYR', 'USA', ['G', 'N', 'EO', 'P', 251]),
];

/**
 * `/asylum-decisions/` rows, with the same US multi-unit series and the same
 * world and Syrian-origin scopes as the applications. Syrian decisions in
 * Morocco (2024 and 2025) are all otherwise closed: no substantive decision.
 */
export const ASYLUM_DECISION_ROWS: RawRow[] = [
  // World, first row of 2000 (the dataset's first year)
  decisionRow(2000, null, null, ['G', 'FI', 'C'], [15062, 11517, 60343, 29915, 116851]),
  // World 2024, every row
  decisionRow(2024, null, null, ['U', 'FI', 'P'], [34444, '0', 5961, 48793, 89198]),
  decisionRow(2024, null, null, ['G', 'FI', 'P'], [405733, 196709, 428650, 345474, 1376566]),
  decisionRow(2024, null, null, ['G', 'AR', 'P'], [19624, 4962, 103324, 36165, 164075]),
  decisionRow(2024, null, null, ['G', 'FA', 'P'], [43702, 15481, 21955, 50580, 131718]),
  decisionRow(2024, null, null, ['G', 'JR', 'P'], [4169, 3608, 40342, 62394, 110513]),
  decisionRow(2024, null, null, ['G', 'RA', 'P'], [3479, 2790, 6536, 20429, 33234]),
  decisionRow(2024, null, null, ['U', 'AR', 'P'], [784, '0', 1488, 3207, 5479]),
  decisionRow(2024, null, null, ['G', 'TA', 'P'], [5298, '0', '0', 1072, 6370]),
  decisionRow(2024, null, null, ['U', 'RA', 'P'], [121, '0', 10, 37, 168]),
  decisionRow(2024, null, null, ['G', 'EO', 'P'], [14806, '0', 19712, 86138, 120656]),
  decisionRow(2024, null, null, ['G', 'IN', 'P'], [17630, '0', 5392, 99490, 122512]),
  decisionRow(2024, null, null, ['J', 'FI', 'P'], [106, 2397, '0', 1394, 3897]),
  // World 2025, every row: persons and cases within one year
  decisionRow(2025, null, null, ['G', 'FI', 'P'], [311879, 149583, 604013, 419559, 1485034]),
  decisionRow(2025, null, null, ['U', 'FI', 'P'], [27446, '0', 3295, 65416, 96157]),
  decisionRow(2025, null, null, ['G', 'AR', 'C'], [7873, '0', 26569, 16165, 50607]),
  decisionRow(2025, null, null, ['G', 'FA', 'P'], [75030, 5287, 40109, 133002, 253428]),
  decisionRow(2025, null, null, ['G', 'JR', 'P'], [3866, 3593, 48168, 65233, 120860]),
  decisionRow(2025, null, null, ['G', 'AR', 'P'], [13425, 5228, 78737, 19510, 116900]),
  decisionRow(2025, null, null, ['G', 'RA', 'P'], [31937, 1921, 12841, 24562, 71261]),
  decisionRow(2025, null, null, ['U', 'AR', 'P'], [1915, '0', 951, 1185, 4051]),
  decisionRow(2025, null, null, ['G', 'FI', 'C'], [169, '0', 1444, 20805, 22418]),
  decisionRow(2025, null, null, ['G', 'TA', 'P'], [7772, '0', '0', 874, 8646]),
  decisionRow(2025, null, null, ['U', 'RA', 'P'], [114, '0', '0', 1321, 1435]),
  decisionRow(2025, null, null, ['G', 'EO', 'P'], [21198, '0', 89890, 129854, 240942]),
  decisionRow(2025, null, null, ['J', 'FI', 'P'], [70, '0', '0', 649, 719]),
  decisionRow(2025, null, null, ['G', 'NA', 'P'], ['0', '0', '0', 1467, 1467]),
  decisionRow(2025, null, null, ['G', 'JR', 'C'], ['0', '0', '0', 5600, 5600]),
  decisionRow(2025, null, null, ['G', 'IN', 'C'], [13555, '0', 23573, 319534, 356662]),
  // Asylum USA, 2015–2016: EOIR persons beside USCIS cases in each year
  decisionRow(2015, null, 'USA', ['G', 'EO', 'P'], [8081, 602, 9217, 26091, 43991]),
  decisionRow(2015, null, 'USA', ['G', 'IN', 'C'], [15298, '0', 290, 23415, 39003]),
  decisionRow(2016, null, 'USA', ['G', 'EO', 'P'], [9290, '0', 12537, 34305, 56132]),
  decisionRow(2016, null, 'USA', ['G', 'IN', 'C'], [11193, '0', 89, 20542, 31824]),
  // Origin SYR, every asylum country summed, 2024–2025
  decisionRow(2024, 'SYR', null, ['G', 'FI', 'P'], [42795, 73286, 2673, 29394, 148148]),
  decisionRow(2024, 'SYR', null, ['U', 'FI', 'P'], [415, '0', '0', 4593, 5008]),
  decisionRow(2024, 'SYR', null, ['U', 'RA', 'P'], ['0', '0', '0', 5, 5]),
  decisionRow(2024, 'SYR', null, ['G', 'AR', 'P'], [310, 52, 826, 961, 2149]),
  decisionRow(2024, 'SYR', null, ['G', 'FA', 'P'], [12577, 11963, 1295, 6815, 32650]),
  decisionRow(2024, 'SYR', null, ['G', 'JR', 'P'], [218, 68, 3357, 8993, 12636]),
  decisionRow(2024, 'SYR', null, ['J', 'FI', 'P'], [10, '0', '0', '0', 10]),
  decisionRow(2024, 'SYR', null, ['G', 'RA', 'P'], [211, 733, 56, 1927, 2927]),
  decisionRow(2024, 'SYR', null, ['G', 'TA', 'P'], [61, '0', '0', 30, 91]),
  decisionRow(2024, 'SYR', null, ['G', 'EO', 'P'], [5, '0', 21, 29, 55]),
  decisionRow(2024, 'SYR', null, ['G', 'IN', 'P'], [87, '0', 23, 86, 196]),
  decisionRow(2025, 'SYR', null, ['G', 'FI', 'P'], [3976, 4208, 13290, 25446, 46920]),
  decisionRow(2025, 'SYR', null, ['U', 'FI', 'P'], [28, '0', '0', 303, 331]),
  decisionRow(2025, 'SYR', null, ['G', 'FA', 'P'], [1784, 3037, 2050, 1920, 8791]),
  decisionRow(2025, 'SYR', null, ['G', 'JR', 'P'], [19, 66, 2458, 11665, 14208]),
  decisionRow(2025, 'SYR', null, ['G', 'AR', 'P'], [91, 118, 468, 345, 1022]),
  decisionRow(2025, 'SYR', null, ['J', 'FI', 'P'], [27, '0', '0', '0', 27]),
  decisionRow(2025, 'SYR', null, ['G', 'RA', 'P'], [15, 14, 128, 1364, 1521]),
  decisionRow(2025, 'SYR', null, ['G', 'TA', 'P'], [3390, '0', '0', 150, 3540]),
  decisionRow(2025, 'SYR', null, ['G', 'EO', 'P'], [15, '0', 84, 41, 140]),
  // Origin SYR by asylum country, 2024–2025 (the fixture countries plus the US)
  decisionRow(2024, 'SYR', 'AUT', ['G', 'FA', 'P'], [12478, 5468, 146, 600, 18692]),
  decisionRow(2024, 'SYR', 'GBR', ['G', 'FI', 'P'], [3227, 81, 51, 116, 3475]),
  decisionRow(2024, 'SYR', 'GBR', ['G', 'RA', 'P'], [63, 5, '0', 5, 73]),
  decisionRow(2024, 'SYR', 'DEU', ['G', 'FI', 'P'], [6946, 70045, 20, 14073, 91084]),
  decisionRow(2024, 'SYR', 'DEU', ['G', 'JR', 'P'], [218, 63, 3172, 8867, 12320]),
  decisionRow(2024, 'SYR', 'DEU', ['G', 'RA', 'P'], [127, 728, 5, 1864, 2724]),
  decisionRow(2024, 'SYR', 'JPN', ['G', 'FA', 'P'], [17, '0', '0', '0', 17]),
  decisionRow(2024, 'SYR', 'MAR', ['U', 'FI', 'P'], ['0', '0', '0', 5, 5]),
  decisionRow(2024, 'SYR', 'UKR', ['G', 'FI', 'P'], ['0', 5, 5, '0', 10]),
  decisionRow(2024, 'SYR', 'USA', ['G', 'AR', 'P'], [42, '0', '0', 32, 74]),
  decisionRow(2024, 'SYR', 'USA', ['G', 'EO', 'P'], [5, '0', 21, 29, 55]),
  decisionRow(2024, 'SYR', 'USA', ['G', 'IN', 'P'], [87, '0', 23, 86, 196]),
  decisionRow(2025, 'SYR', 'AUS', ['G', 'FA', 'P'], [28, '0', 11, 11, 50]),
  decisionRow(2025, 'SYR', 'AUT', ['G', 'FA', 'P'], [1290, 2186, 430, 475, 4381]),
  decisionRow(2025, 'SYR', 'GBR', ['G', 'FI', 'P'], [45, 19, 566, 509, 1139]),
  decisionRow(2025, 'SYR', 'GBR', ['G', 'RA', 'P'], ['0', '0', 5, 48, 53]),
  decisionRow(2025, 'SYR', 'DEU', ['G', 'FI', 'P'], [143, 367, 9487, 13914, 23911]),
  decisionRow(2025, 'SYR', 'DEU', ['G', 'JR', 'P'], [19, 61, 2190, 11426, 13696]),
  decisionRow(2025, 'SYR', 'DEU', ['G', 'RA', 'P'], [10, 14, 83, 1275, 1382]),
  decisionRow(2025, 'SYR', 'MAR', ['U', 'FI', 'P'], ['0', '0', '0', 63, 63]),
  decisionRow(2025, 'SYR', 'UKR', ['G', 'FI', 'P'], ['0', '0', 15, '0', 15]),
  decisionRow(2025, 'SYR', 'UKR', ['G', 'JR', 'P'], ['0', '0', 14, '0', 14]),
  decisionRow(2025, 'SYR', 'USA', ['G', 'EO', 'P'], [15, '0', 84, 41, 140]),
];

/**
 * `/demographics/` rows in the `ptype_show=true` shape, one row per population
 * type; the fake upstream sums them per key when a request omits `ptype_show`,
 * as UNHCR does. Rows UNHCR has no breakdown for carry `"0"` in every band.
 */
export const DEMOGRAPHICS_ROWS: RawRow[] = [
  // World 2001 (the dataset's first year), every type
  demographicsRow(2001, null, null, 'IDP', 5096502, {
    f: [12865, 33495, 28719, 158411, 49784, 304401, 587675],
    m: [13849, 34313, 29432, 139717, 34360, 268554, 520225],
  }),
  demographicsRow(2001, null, null, 'RET', 462396, NO_BREAKDOWN),
  demographicsRow(2001, null, null, 'REF', 12116301, {
    f: [405504, 592793, 508222, 1474721, 215361, 313452, 3510053],
    m: [410117, 631963, 541707, 1716788, 201847, 336249, 3838671],
  }),
  demographicsRow(2001, null, null, 'ASY', 943383, {
    f: [3096, 3906, 3347, 14939, 489, 19051, 44828],
    m: [3149, 4334, 3698, 27806, 672, 47353, 87012],
  }),
  demographicsRow(2001, null, null, 'OOC', 1039510, {
    f: [2820, 10257, 8793, 43370, 1750, '0', 66990],
    m: [3275, 10591, 9079, 46580, 1485, '0', 71010],
  }),
  demographicsRow(2001, null, null, 'RDP', 240950, NO_BREAKDOWN),
  // World 2025, every type
  demographicsRow(2025, null, null, 'OOC', 2957025, {
    f: [50080, 73949, 50163, 220901, 17253, 291658, 704004],
    m: [51809, 75404, 50081, 320692, 19623, 317710, 835319],
  }),
  demographicsRow(2025, null, null, 'OIP', 7177473, {
    f: [109267, 364282, 284333, 1890113, 108334, 76632, 2832961],
    m: [111719, 395263, 287004, 1652799, 61475, 106447, 2614707],
  }),
  demographicsRow(2025, null, null, 'HST', 26670162, {
    f: [40309, 59817, 47970, 141318, 21802, 842102, 1153318],
    m: [37806, 60404, 48093, 130821, 18107, 843905, 1139136],
  }),
  demographicsRow(2025, null, null, 'IDP', 64239352, {
    f: [1702054, 3029889, 2706983, 9415045, 1812739, 986879, 19653589],
    m: [1653687, 3059618, 2653166, 7831679, 1411377, 850414, 17459941],
  }),
  demographicsRow(2025, null, null, 'RDP', 10308567, {
    f: [14409, 28159, 28165, 123150, 30893, 1677120, 1901896],
    m: [15215, 29365, 27581, 105304, 20904, 1565017, 1763386],
  }),
  demographicsRow(2025, null, null, 'RET', 4362272, {
    f: [173832, 249386, 144120, 462594, 40873, 50, 1070855],
    m: [170906, 255742, 153042, 951555, 53891, 43, 1585179],
  }),
  demographicsRow(2025, null, null, 'ASY', 8998095, {
    f: [157019, 252996, 188582, 1109519, 89664, 20495, 1818275],
    m: [159228, 266942, 218403, 1543853, 76670, 48527, 2313623],
  }),
  demographicsRow(2025, null, null, 'REF', 28461306, {
    f: [1141819, 2228383, 1632385, 6065654, 660126, 1154389, 12882756],
    m: [1151161, 2258475, 1713490, 5966408, 490517, 1113557, 12693608],
  }),
  demographicsRow(2025, null, null, 'STA', 2875412, {
    f: [149388, 132027, 98286, 466119, 61958, 87217, 994995],
    m: [154505, 150737, 94090, 376879, 58405, 93862, 928478],
  }),
  // Origin SYR, every asylum country summed, 2025: HST, IDP, RDP, and RET have no breakdown
  demographicsRow(2025, 'SYR', null, 'OOC', 5940, {
    f: [128, 241, 233, 646, 20, '0', 1268],
    m: [99, 209, 196, 392, 15, '0', 911],
  }),
  demographicsRow(2025, 'SYR', null, 'REF', 4865764, {
    f: [255001, 456616, 304387, 1107424, 82237, 37526, 2243191],
    m: [268328, 481894, 333016, 1385950, 72924, 46464, 2588576],
  }),
  demographicsRow(2025, 'SYR', null, 'ASY', 154355, {
    f: [7830, 6980, 4748, 23419, 1841, 1344, 46162],
    m: [7459, 8307, 12624, 68895, 1971, 6790, 106046],
  }),
  demographicsRow(2025, 'SYR', null, 'HST', 16504958, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', null, 'IDP', 5542227, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', null, 'RDP', 1964201, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', null, 'RET', 1341148, NO_BREAKDOWN),
  // Origin SYR, asylum DEU, 2024
  demographicsRow(2024, 'SYR', 'DEU', 'ASY', 62959, {
    f: [2659, 3130, 1883, 9297, 386, '0', 17355],
    m: [2796, 3604, 6578, 31802, 468, '0', 45248],
  }),
  demographicsRow(2024, 'SYR', 'DEU', 'REF', 725102, {
    f: [22781, 52613, 35793, 146543, 11326, 25, 269081],
    m: [24484, 56340, 46846, 313633, 13979, 97, 455379],
  }),
  // Origin SYR by asylum country, 2025 (the fixture countries plus the US)
  demographicsRow(2025, 'SYR', 'EGY', 'REF', 117364, {
    f: [4016, 8182, 7868, 31540, 3694, '0', 55300],
    m: [4202, 8728, 8308, 37346, 3480, '0', 62064],
  }),
  demographicsRow(2025, 'SYR', 'AUS', 'ASY', 166, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'AUS', 'REF', 166, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'AUT', 'ASY', 10883, {
    f: [1034, 846, 462, 1674, 62, '0', 4078],
    m: [878, 1018, 830, 4015, 64, '0', 6805],
  }),
  demographicsRow(2025, 'SYR', 'AUT', 'REF', 100322, {
    f: [8889, 12973, 4412, 17884, 462, '0', 44620],
    m: [8447, 14599, 5528, 26676, 452, '0', 55702],
  }),
  demographicsRow(2025, 'SYR', 'GBR', 'ASY', 7501, {
    f: ['0', '0', '0', '0', '0', 1132, 1132],
    m: ['0', '0', '0', '0', '0', 6369, 6369],
  }),
  demographicsRow(2025, 'SYR', 'GBR', 'REF', 17592, {
    f: [61, 669, 2087, 3690, 2201, '0', 8708],
    m: [61, 646, 2092, 3919, 2166, '0', 8884],
  }),
  demographicsRow(2025, 'SYR', 'DEU', 'ASY', 65511, {
    f: [5278, 3264, 1951, 10375, 525, '0', 21393],
    m: [5487, 3850, 6174, 28037, 570, '0', 44118],
  }),
  demographicsRow(2025, 'SYR', 'DEU', 'REF', 668647, {
    f: [15452, 49476, 33504, 139753, 12066, 5, 250256],
    m: [16750, 52681, 41657, 291711, 14836, 5, 417640],
  }),
  demographicsRow(2025, 'SYR', 'IRQ', 'REF', 308226, {
    f: [16061, 29088, 14995, 69403, 6099, '0', 135646],
    m: [16857, 30943, 16059, 103948, 4773, '0', 172580],
  }),
  demographicsRow(2025, 'SYR', 'JOR', 'REF', 420835, {
    f: [24964, 43803, 32948, 102477, 9948, '0', 214140],
    m: [25896, 45965, 34729, 93333, 6772, '0', 206695],
  }),
  demographicsRow(2025, 'SYR', 'JPN', 'REF', 456, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'LBN', 'OOC', 2172, {
    f: [128, 241, 233, 639, 20, '0', 1261],
    m: [99, 209, 196, 392, 15, '0', 911],
  }),
  demographicsRow(2025, 'SYR', 'LBN', 'REF', 532357, {
    f: [25985, 62932, 50719, 129743, 7186, '0', 276565],
    m: [27688, 65229, 53097, 104106, 5672, '0', 255792],
  }),
  demographicsRow(2025, 'SYR', 'MAR', 'REF', 5216, {
    f: [243, 483, 319, 1156, 86, '0', 2287],
    m: [303, 544, 367, 1604, 111, '0', 2929],
  }),
  demographicsRow(2025, 'SYR', 'SYR', 'HST', 16504958, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'SYR', 'IDP', 5542227, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'SYR', 'RDP', 1964201, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'SYR', 'RET', 1341148, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'TUR', 'REF', 2347756, {
    f: [154087, 238273, 148727, 558194, 35984, '0', 1135265],
    m: [164328, 252230, 158124, 607662, 30147, '0', 1212491],
  }),
  demographicsRow(2025, 'SYR', 'UKR', 'ASY', 9, {
    f: ['0', '0', '0', '0', '0', '0', '0'],
    m: ['0', '0', '0', 9, '0', '0', 9],
  }),
  demographicsRow(2025, 'SYR', 'UKR', 'REF', 501, {
    f: ['0', '0', 14, 73, '0', '0', 87],
    m: ['0', '0', 13, 396, 5, '0', 414],
  }),
  demographicsRow(2025, 'SYR', 'USA', 'ASY', 1070, NO_BREAKDOWN),
  demographicsRow(2025, 'SYR', 'USA', 'REF', 7740, NO_BREAKDOWN),
];

interface FootnoteSpec {
  coa: string | null;
  coo: string | null;
  footnote: string;
  population_type: string;
  year: string;
}

/**
 * A `/footnotes/` row in the recorded shape: a blank country is `" "` with id
 * 278 and an empty ISO code; a named one carries its display name and ISO3.
 */
export const footnoteRow = (spec: FootnoteSpec): RawRow => {
  const side = (prefix: 'coa' | 'coo', iso: string | null): RawRow => {
    if (iso === null) {
      return { [prefix]: ' ', [`${prefix}_id`]: 278, [`${prefix}_iso`]: '' };
    }
    const row = COUNTRY_ROWS.find((candidate) => candidate.iso === iso);
    return {
      [prefix]: row ? row.name : iso,
      [`${prefix}_id`]: row ? row.id : 0,
      [`${prefix}_iso`]: iso,
    };
  };
  return {
    footnote: spec.footnote,
    year: spec.year,
    ...side('coo', spec.coo),
    ...side('coa', spec.coa),
    population_type: spec.population_type,
  };
};

/** Footnote text with the `\r\r\n` line breaks two upstream footnotes carry. */
export const MULTILINE_FOOTNOTE_TEXT =
  'The Albanian Government conducted the Population and Housing Census during the period of September–October 2023.\r\r\n\r\r\nThe start-year figures are based on an identification exercise conducted in 2021.';

/** `/footnotes/` rows (abridged texts), covering every year-spec and country form. */
export const FOOTNOTE_ROWS: RawRow[] = [
  footnoteRow({
    footnote:
      'Since 2022, the total figure of refugees from Ukraine in Germany has included individuals still waiting for a decision on Temporary Protection.',
    year: '2025',
    coo: null,
    coa: 'DEU',
    population_type: 'REF',
  }),
  footnoteRow({
    footnote:
      'The figure does not represent the entire number of persons registered as stateless in the German Central Aliens Register.',
    year: '2015 - 2017',
    coo: null,
    coa: 'DEU',
    population_type: 'STA',
  }),
  footnoteRow({
    footnote: 'Refugee figure for Syrians in Turkey is a Government estimate.',
    year: '2017 - 2018',
    coo: 'SYR',
    coa: 'TUR',
    population_type: 'REF',
  }),
  footnoteRow({
    footnote:
      'The total figure of refugees and asylum-seekers by end-2025 is based on official data published by the Turkish Government.',
    year: '2025',
    coo: null,
    coa: 'TUR',
    population_type: 'REF,ASY',
  }),
  footnoteRow({
    footnote: 'The Lebanese government estimates that 1.5 million Syrians are in Lebanon.',
    year: '2024',
    coo: null,
    coa: 'LBN',
    population_type: 'REF',
  }),
  footnoteRow({
    footnote:
      'The data are generally provided by governments, based on their own definitions and methods of data collection.',
    year: '2019 - 2022',
    coo: null,
    coa: null,
    population_type: 'REF,ROC,ASY,IDP,IOC,STA,OOC,RET,RDP,HST,OIP,RST,NAT',
  }),
  footnoteRow({
    footnote: MULTILINE_FOOTNOTE_TEXT,
    year: '2023',
    coo: null,
    coa: 'ALB',
    population_type: 'STA',
  }),
  footnoteRow({
    footnote: 'Refers to Palestinian refugees under the UNHCR mandate only.',
    year: '2015 - 2018, 2020 - 2024',
    coo: 'PSE',
    coa: null,
    population_type: 'REF,ROC,ASY,IDP,IOC,STA,OOC,RET,RDP,HST,OIP,RST,NAT',
  }),
  footnoteRow({
    footnote:
      'Naturalization figures refer to the admission of protected persons as permanent residents of Canada.',
    year: '2022 - 2024',
    coo: null,
    coa: 'CAN',
    population_type: 'NAT',
  }),
  // Illustrative: a solutions-type caveat naming Syria as origin.
  footnoteRow({
    footnote: 'Return figures for Syria combine government and UNHCR operational estimates.',
    year: '2024 - 2025',
    coo: 'SYR',
    coa: null,
    population_type: 'RET,RDP',
  }),
  // Illustrative: an entry with no text, which the service drops.
  footnoteRow({ footnote: '   ', year: '2024', coo: null, coa: null, population_type: 'REF' }),
];

/**
 * Envelope for a data endpoint. `total` is `[]` on population, demographics,
 * the companions, and nowcasting; on the asylum endpoints and solutions it is
 * an object of whole-query column sums.
 */
export const envelope = (
  items: RawRow[],
  options: { maxPages?: number; page?: number; total?: RawRow } = {},
): RawRow => ({
  page: options.page ?? 1,
  'short-url': 'TEST00',
  maxPages: options.maxPages ?? (items.length > 0 ? 1 : 0),
  total: options.total ?? [],
  items,
});
