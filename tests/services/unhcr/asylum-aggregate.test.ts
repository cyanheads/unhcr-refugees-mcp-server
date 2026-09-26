/**
 * @fileoverview Tests for the asylum aggregation: the procedure-code filters,
 * grouping by the requested split dimensions plus unit, summing, and (for
 * decisions) substantive decisions and UNHCR's two rates. Inputs are
 * normalized rows carrying recorded upstream values — the US multi-unit
 * series, Syrian-origin and Syria → Germany rows, and the world 2000 row whose
 * published total differs from its outcomes — plus a few illustrative rows
 * for unit codes and null cells the recorded data never shows.
 * @module tests/services/unhcr/asylum-aggregate.test
 */

import { describe, expect, it } from 'vitest';
import { aggregateApplications, aggregateDecisions } from '@/services/unhcr/asylum-aggregate.js';
import type {
  AsylumApplicationRow,
  AsylumDecisionRow,
  RowIdentity,
} from '@/services/unhcr/types.js';

type Count = number | null;

const identity = (year: number, origin: string | null, asylum: string | null): RowIdentity => ({
  year,
  origin_iso3: origin,
  origin_unhcr_code: origin,
  origin_name: origin,
  asylum_iso3: asylum,
  asylum_unhcr_code: asylum,
  asylum_name: asylum,
});

/** A normalized application row: authority, stage, decision level, unit, applied. */
const app = (
  year: number,
  origin: string | null,
  asylum: string | null,
  [authority, stage, decision_level, unit, applied]: [string, string, string, string | null, Count],
): AsylumApplicationRow => ({
  ...identity(year, origin, asylum),
  authority,
  stage,
  decision_level,
  unit,
  applied,
});

/** A normalized decision row: authority, level, unit, then the five upstream counts. */
const dec = (
  year: number,
  origin: string | null,
  asylum: string | null,
  [authority, decision_level, unit]: [string, string, string | null],
  [dec_recognized, dec_other, dec_rejected, dec_closed, dec_total]: Count[],
): AsylumDecisionRow => ({
  ...identity(year, origin, asylum),
  authority,
  decision_level,
  unit,
  dec_recognized: dec_recognized ?? null,
  dec_other: dec_other ?? null,
  dec_rejected: dec_rejected ?? null,
  dec_closed: dec_closed ?? null,
  dec_total: dec_total ?? null,
});

/** Asylum USA: EOIR persons beside USCIS cases in each year (recorded). */
const US_APPLICATIONS = [
  app(2015, null, 'USA', ['G', 'N', 'EO', 'P', 45394]),
  app(2015, null, 'USA', ['G', 'N', 'IN', 'C', 90582]),
  app(2016, null, 'USA', ['G', 'N', 'EO', 'P', 80567]),
  app(2016, null, 'USA', ['G', 'N', 'IN', 'C', 124234]),
];

/** Origin SYR, every asylum country summed, 2025: person rows plus two case rows (recorded). */
const SYR_APPLICATIONS_2025 = [
  app(2025, 'SYR', null, ['G', 'N', 'FI', 'P', 40422]),
  app(2025, 'SYR', null, ['U', 'N', 'FI', 'P', 554]),
  app(2025, 'SYR', null, ['G', 'A', 'AR', 'C', 5]),
  app(2025, 'SYR', null, ['G', 'NR', 'FA', 'P', 1220]),
  app(2025, 'SYR', null, ['G', 'N', 'FA', 'P', 4656]),
  app(2025, 'SYR', null, ['G', 'R', 'RA', 'P', 2106]),
  app(2025, 'SYR', null, ['G', 'A', 'JR', 'P', 17681]),
  app(2025, 'SYR', null, ['G', 'A', 'AR', 'P', 1398]),
  app(2025, 'SYR', null, ['G', 'N', 'FI', 'C', 9]),
  app(2025, 'SYR', null, ['G', 'R', 'FI', 'P', 252]),
  app(2025, 'SYR', null, ['G', 'RA', 'RA', 'P', 245]),
  app(2025, 'SYR', null, ['G', 'N', 'TA', 'P', 3196]),
  app(2025, 'SYR', null, ['G', 'RA', 'FI', 'P', 14]),
  app(2025, 'SYR', null, ['G', 'J', 'JR', 'P', 5]),
  app(2025, 'SYR', null, ['G', 'N', 'EO', 'P', 251]),
];

/** Syria → Germany 2024, one row per decision level (recorded). */
const SYR_DEU_DECISIONS_2024 = [
  dec(2024, 'SYR', 'DEU', ['G', 'FI', 'P'], [6946, 70045, 20, 14073, 91084]),
  dec(2024, 'SYR', 'DEU', ['G', 'JR', 'P'], [218, 63, 3172, 8867, 12320]),
  dec(2024, 'SYR', 'DEU', ['G', 'RA', 'P'], [127, 728, 5, 1864, 2724]),
];

/** Asylum USA decisions: EOIR persons beside USCIS cases (recorded). */
const US_DECISIONS_2015 = [
  dec(2015, null, 'USA', ['G', 'EO', 'P'], [8081, 602, 9217, 26091, 43991]),
  dec(2015, null, 'USA', ['G', 'IN', 'C'], [15298, 0, 290, 23415, 39003]),
];

describe('aggregateApplications', () => {
  it('never adds cases to persons: the US series keeps EOIR persons and USCIS cases apart each year', () => {
    const { rows, skippedRows } = aggregateApplications(US_APPLICATIONS, {
      splitBy: [],
      stages: [],
    });
    expect(skippedRows).toBe(0);
    expect(rows.map((row) => [row.year, row.unit, row.applied, row.decision_levels])).toEqual([
      [2015, 'persons', 45394, ['EO']],
      [2016, 'persons', 80567, ['EO']],
      [2015, 'cases', 90582, ['IN']],
      [2016, 'cases', 124234, ['IN']],
    ]);
    expect(rows.map((row) => row.applied)).not.toContain(45394 + 90582);
  });

  it('splits by stage when asked, summing authority and decision level and listing the codes summed', () => {
    const { rows } = aggregateApplications(SYR_APPLICATIONS_2025, {
      splitBy: ['stage'],
      stages: [],
    });
    expect(rows.map((row) => [row.unit, row.stages, row.applied])).toEqual([
      ['persons', ['A'], 19079],
      ['persons', ['J'], 5],
      ['persons', ['N'], 49079],
      ['persons', ['NR'], 1220],
      ['persons', ['R'], 2358],
      ['persons', ['RA'], 259],
      ['cases', ['A'], 5],
      ['cases', ['N'], 9],
    ]);
    expect(rows[2]).toEqual({
      ...identity(2025, 'SYR', null),
      authorities: ['G', 'U'],
      stages: ['N'],
      decision_levels: ['EO', 'FA', 'FI', 'TA'],
      unit: 'persons',
      applied: 49079,
    });
  });

  it('with no split dimension, gives one total per year and unit', () => {
    const { rows } = aggregateApplications(SYR_APPLICATIONS_2025, { splitBy: [], stages: [] });
    expect(rows).toEqual([
      {
        ...identity(2025, 'SYR', null),
        authorities: ['G', 'U'],
        stages: ['A', 'J', 'N', 'NR', 'R', 'RA'],
        decision_levels: ['AR', 'EO', 'FA', 'FI', 'JR', 'RA', 'TA'],
        unit: 'persons',
        applied: 72000,
      },
      {
        ...identity(2025, 'SYR', null),
        authorities: ['G'],
        stages: ['A', 'N'],
        decision_levels: ['AR', 'FI'],
        unit: 'cases',
        applied: 14,
      },
    ]);
  });

  it('splits by every requested dimension, down to one upstream row per group', () => {
    const { rows } = aggregateApplications(SYR_APPLICATIONS_2025, {
      splitBy: ['authority', 'stage', 'decision_level'],
      stages: [],
    });
    expect(rows).toHaveLength(SYR_APPLICATIONS_2025.length);
    for (const row of rows) {
      expect(row.authorities).toHaveLength(1);
      expect(row.stages).toHaveLength(1);
      expect(row.decision_levels).toHaveLength(1);
    }
    const splitByAuthority = aggregateApplications(SYR_APPLICATIONS_2025, {
      splitBy: ['authority'],
      stages: [],
    });
    expect(splitByAuthority.rows.map((row) => [row.unit, row.authorities, row.applied])).toEqual([
      ['persons', ['G'], 71446],
      ['persons', ['U'], 554],
      ['cases', ['G'], 14],
    ]);
  });

  it('filters stages before summing, and a filter matching nothing leaves no rows', () => {
    const newOnly = aggregateApplications(SYR_APPLICATIONS_2025, {
      splitBy: [],
      stages: ['N'],
    });
    expect(newOnly.rows.map((row) => [row.unit, row.stages, row.applied])).toEqual([
      ['persons', ['N'], 49079],
      ['cases', ['N'], 9],
    ]);
    const none = aggregateApplications(SYR_APPLICATIONS_2025, { splitBy: [], stages: ['V'] });
    expect(none).toEqual({ rows: [], skippedRows: 0 });
  });

  it('keeps each country pair and year its own group', () => {
    const { rows } = aggregateApplications(
      [
        app(2025, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', 23256]),
        app(2025, 'SYR', 'GBR', ['G', 'N', 'FI', 'P', 1959]),
        app(2024, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', 76765]),
      ],
      { splitBy: [], stages: [] },
    );
    expect(rows.map((row) => [row.year, row.asylum_iso3, row.applied])).toEqual([
      [2025, 'DEU', 23256],
      [2025, 'GBR', 1959],
      [2024, 'DEU', 76765],
    ]);
  });

  it('leaves out rows whose unit is neither P nor C, counting them instead of guessing', () => {
    const { rows, skippedRows } = aggregateApplications(
      [
        ...US_APPLICATIONS.slice(0, 2),
        // Illustrative: unit codes no recorded row carries.
        app(2015, null, 'USA', ['G', 'N', 'EO', 'X', 700]),
        app(2015, null, 'USA', ['G', 'N', 'IN', null, 800]),
      ],
      { splitBy: [], stages: [] },
    );
    expect(skippedRows).toBe(2);
    expect(rows.map((row) => [row.unit, row.applied])).toEqual([
      ['persons', 45394],
      ['cases', 90582],
    ]);
  });

  it('keeps a sum null only while every value in it is null', () => {
    const { rows } = aggregateApplications(
      [
        app(2025, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', null]),
        app(2025, 'SYR', 'DEU', ['G', 'A', 'JR', 'P', null]),
        app(2025, 'SYR', 'GBR', ['G', 'N', 'FI', 'P', null]),
        app(2025, 'SYR', 'GBR', ['G', 'R', 'RA', 'P', 72]),
      ],
      { splitBy: [], stages: [] },
    );
    expect(rows.map((row) => [row.asylum_iso3, row.applied])).toEqual([
      ['DEU', null],
      ['GBR', 72],
    ]);
  });
});

describe('aggregateDecisions', () => {
  it('computes substantive decisions and both rates from summed counts, never by averaging levels', () => {
    const { rows } = aggregateDecisions(SYR_DEU_DECISIONS_2024, {
      splitBy: [],
      decisionLevels: [],
    });
    expect(rows).toEqual([
      {
        ...identity(2024, 'SYR', 'DEU'),
        authorities: ['G'],
        decision_levels: ['FI', 'JR', 'RA'],
        unit: 'persons',
        recognized: 7291,
        complementary_protection: 70836,
        rejected: 3197,
        otherwise_closed: 24804,
        total_decisions: 106128,
        substantive_decisions: 81324,
        refugee_recognition_rate: 9,
        total_protection_rate: 96.1,
      },
    ]);
    // The mean of the three per-level recognition rates is 10.0, not the 9.0 above.
    const levels = aggregateDecisions(SYR_DEU_DECISIONS_2024, {
      splitBy: ['decision_level'],
      decisionLevels: [],
    });
    const mean =
      levels.rows.reduce((sum, row) => sum + (row.refugee_recognition_rate ?? 0), 0) /
      levels.rows.length;
    expect(Math.round(mean * 10) / 10).toBe(10);
  });

  it('splits by decision level, with each level’s own rates', () => {
    const { rows } = aggregateDecisions(SYR_DEU_DECISIONS_2024, {
      splitBy: ['decision_level'],
      decisionLevels: [],
    });
    expect(
      rows.map((row) => [
        row.decision_levels,
        row.substantive_decisions,
        row.refugee_recognition_rate,
        row.total_protection_rate,
      ]),
    ).toEqual([
      [['FI'], 77011, 9, 100],
      [['JR'], 3453, 6.3, 8.1],
      [['RA'], 860, 14.8, 99.4],
    ]);
  });

  it('never adds case-counted decisions to person-counted ones, rating each unit on its own', () => {
    const { rows } = aggregateDecisions(US_DECISIONS_2015, { splitBy: [], decisionLevels: [] });
    expect(
      rows.map((row) => [
        row.unit,
        row.decision_levels,
        row.substantive_decisions,
        row.refugee_recognition_rate,
        row.total_protection_rate,
      ]),
    ).toEqual([
      ['persons', ['EO'], 17900, 45.1, 48.5],
      ['cases', ['IN'], 15588, 98.1, 98.1],
    ]);
  });

  it('nulls both rates when there are no substantive decisions, keeping the zero denominator', () => {
    const { rows } = aggregateDecisions(
      [dec(2025, 'SYR', 'MAR', ['U', 'FI', 'P'], [0, 0, 0, 63, 63])],
      { splitBy: [], decisionLevels: [] },
    );
    expect(rows[0]).toMatchObject({
      recognized: 0,
      complementary_protection: 0,
      rejected: 0,
      otherwise_closed: 63,
      substantive_decisions: 0,
      refugee_recognition_rate: null,
      total_protection_rate: null,
    });
  });

  it('reports 0%, not null, when substantive decisions exist and none recognized', () => {
    const { rows } = aggregateDecisions(
      [
        dec(2025, 'SYR', 'UKR', ['G', 'FI', 'P'], [0, 0, 15, 0, 15]),
        dec(2025, 'SYR', 'UKR', ['G', 'JR', 'P'], [0, 0, 14, 0, 14]),
      ],
      { splitBy: [], decisionLevels: [] },
    );
    expect(rows[0]).toMatchObject({
      substantive_decisions: 29,
      refugee_recognition_rate: 0,
      total_protection_rate: 0,
    });
  });

  it('keeps total_decisions as the sum of UNHCR’s published totals, apart from the outcomes', () => {
    const { rows } = aggregateDecisions(
      [dec(2000, null, null, ['G', 'FI', 'C'], [15062, 11517, 60343, 29915, 116851])],
      { splitBy: [], decisionLevels: [] },
    );
    const [row] = rows;
    expect(row?.total_decisions).toBe(116851);
    expect(
      (row?.recognized ?? 0) +
        (row?.complementary_protection ?? 0) +
        (row?.rejected ?? 0) +
        (row?.otherwise_closed ?? 0),
    ).toBe(116837);
  });

  it('filters decision levels before summing', () => {
    const syr2024 = [
      dec(2024, 'SYR', null, ['G', 'FI', 'P'], [42795, 73286, 2673, 29394, 148148]),
      dec(2024, 'SYR', null, ['U', 'FI', 'P'], [415, 0, 0, 4593, 5008]),
      dec(2024, 'SYR', null, ['G', 'AR', 'P'], [310, 52, 826, 961, 2149]),
      dec(2024, 'SYR', null, ['J', 'FI', 'P'], [10, 0, 0, 0, 10]),
      dec(2024, 'SYR', null, ['G', 'JR', 'P'], [218, 68, 3357, 8993, 12636]),
    ];
    const { rows } = aggregateDecisions(syr2024, { splitBy: [], decisionLevels: ['FI'] });
    expect(rows).toEqual([
      expect.objectContaining({
        authorities: ['G', 'J', 'U'],
        decision_levels: ['FI'],
        recognized: 43220,
        complementary_protection: 73286,
        rejected: 2673,
        substantive_decisions: 119179,
        refugee_recognition_rate: 36.3,
        total_protection_rate: 97.8,
      }),
    ]);
    const splitByAuthority = aggregateDecisions(syr2024, {
      splitBy: ['authority'],
      decisionLevels: ['FI'],
    });
    expect(splitByAuthority.rows.map((row) => [row.authorities, row.recognized])).toEqual([
      [['G'], 42795],
      [['J'], 10],
      [['U'], 415],
    ]);
  });

  it('leaves out rows whose unit is neither P nor C, counting them', () => {
    const { rows, skippedRows } = aggregateDecisions(
      [
        ...US_DECISIONS_2015,
        // Illustrative: a unit code no recorded row carries.
        dec(2015, null, 'USA', ['G', 'EO', 'H'], [1, 1, 1, 1, 4]),
      ],
      { splitBy: [], decisionLevels: [] },
    );
    expect(skippedRows).toBe(1);
    expect(rows.map((row) => [row.unit, row.recognized])).toEqual([
      ['persons', 8081],
      ['cases', 15298],
    ]);
  });

  it('nulls substantive decisions and both rates when any outcome in them is null, never rating a partial denominator', () => {
    const { rows } = aggregateDecisions(
      [
        // Illustrative: "-" in one outcome of an otherwise reported row.
        dec(2025, 'SYR', 'DEU', ['G', 'FI', 'P'], [20, 10, null, 5, 35]),
        dec(2025, 'SYR', 'AUT', ['G', 'FI', 'P'], [20, null, 30, 5, 55]),
      ],
      { splitBy: [], decisionLevels: [] },
    );
    expect(
      rows.map((row) => [
        row.asylum_iso3,
        row.recognized,
        row.complementary_protection,
        row.rejected,
        row.substantive_decisions,
        row.refugee_recognition_rate,
        row.total_protection_rate,
      ]),
    ).toEqual([
      ['DEU', 20, 10, null, null, null, null],
      ['AUT', 20, null, 30, null, null, null],
    ]);
  });

  it('nulls substantive decisions and both rates when an outcome is null in any row summed into the group', () => {
    const rows = [
      // Illustrative: "-" for rejected at one decision level, a number at the other.
      dec(2025, 'SYR', 'DEU', ['G', 'FI', 'P'], [20, 10, null, 5, 35]),
      dec(2025, 'SYR', 'DEU', ['G', 'AR', 'P'], [5, 0, 15, 1, 21]),
    ];
    const summed = aggregateDecisions(rows, { splitBy: [], decisionLevels: [] });
    // A denominator missing FI's rejections would put the rates at 50% and 70%.
    expect(summed.rows).toEqual([
      expect.objectContaining({
        decision_levels: ['AR', 'FI'],
        recognized: 25,
        complementary_protection: 10,
        rejected: 15,
        substantive_decisions: null,
        refugee_recognition_rate: null,
        total_protection_rate: null,
      }),
    ]);
    const levels = aggregateDecisions(rows, { splitBy: ['decision_level'], decisionLevels: [] });
    expect(
      levels.rows.map((row) => [
        row.decision_levels,
        row.substantive_decisions,
        row.refugee_recognition_rate,
        row.total_protection_rate,
      ]),
    ).toEqual([
      [['AR'], 20, 25, 25],
      [['FI'], null, null, null],
    ]);
  });

  it('keeps every count and rate null for a group whose counts are all null', () => {
    const { rows } = aggregateDecisions(
      [dec(2025, 'SYR', 'DEU', ['G', 'FI', 'P'], [null, null, null, null, null])],
      { splitBy: [], decisionLevels: [] },
    );
    expect(rows[0]).toMatchObject({
      recognized: null,
      complementary_protection: null,
      rejected: null,
      otherwise_closed: null,
      total_decisions: null,
      substantive_decisions: null,
      refugee_recognition_rate: null,
      total_protection_rate: null,
    });
  });
});
