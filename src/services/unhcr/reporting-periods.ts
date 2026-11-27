/**
 * @fileoverview Verified statistical reporting periods for the legacy year-only API.
 * @module services/unhcr/reporting-periods
 */

import type { ProbedDataset } from './codes.js';

const ANNUAL_THROUGH = 2025;

/**
 * Captured 2026-11-27. The release date and prior annual vintages come from
 * UNHCR's publication history and Mid-Year Trends, corroborated by its Portal
 * observations. The legacy endpoint has no release ID; withdraw this vintage
 * before an annual replacement could exist, even if the row year is unchanged.
 * https://www.unhcr.org/refugee-statistics/methodology
 * https://www.unhcr.org/sites/default/files/docs/default/2026-11/mid-year-trends-report-2026.pdf
 */
const MID_YEAR_VINTAGE = { year: 2026, expiresAt: Date.UTC(2027, 0, 1) } as const;

const PERIODS = {
  population: {
    series: 'UNHCR population',
    annual: 'stocks at 31 December; returns from January through December.',
    midYear: 'stocks at 30 June; returns from January through June.',
  },
  'asylum-applications': {
    series: 'UNHCR asylum applications',
    annual: 'January through December.',
    midYear: 'January through June.',
  },
  'asylum-decisions': {
    series: 'UNHCR asylum decisions',
    annual: 'January through December.',
    midYear: 'January through June.',
  },
  solutions: {
    series: 'UNHCR durable solutions',
    annual: 'January through December.',
    midYear: 'January through June.',
  },
  demographics: {
    series: 'UNHCR demographics',
    annual: 'annual collection; stocks at 31 December and returns during the year.',
  },
  unrwa: {
    series: 'UNRWA refugee registrations',
    annual: 'year-end reporting period.',
    midYear: 'June 2026 reporting period.',
  },
  idmc: {
    series: 'IDMC conflict displacement',
    annual: 'year-end stocks.',
    midYear: 'end-2025 stock carried forward.',
  },
} as const satisfies Record<ProbedDataset, { series: string; annual: string; midYear?: string }>;

/**
 * Describe only years present in the source, compacting contiguous years that
 * share a release period. Country caveats can narrow the publication window.
 */
export function reportingPeriods(
  dataset: ProbedDataset,
  years: Iterable<number>,
  observedAt: number,
): string[] {
  const series = PERIODS[dataset];
  const spans: { first: number; last: number; period: string }[] = [];
  for (const year of [...new Set(years)].sort((a, b) => a - b)) {
    const period =
      dataset === 'demographics' || year <= ANNUAL_THROUGH
        ? series.annual
        : year === MID_YEAR_VINTAGE.year &&
            observedAt < MID_YEAR_VINTAGE.expiresAt &&
            'midYear' in series
          ? series.midYear
          : 'reporting period unverified.';
    const previous = spans.at(-1);
    if (previous && previous.last === year - 1 && previous.period === period) previous.last = year;
    else spans.push({ first: year, last: year, period });
  }
  return spans.map(
    ({ first, last, period }) =>
      `${first === last ? first : `${first}–${last}`} · ${series.series}: ${period}`,
  );
}
