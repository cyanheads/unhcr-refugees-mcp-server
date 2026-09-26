/**
 * @fileoverview Opt-in live suite, run with `bun run test:live` and never by
 * `bun run test`. Three keyless requests to api.unhcr.org re-check the
 * undocumented upstream behaviors the request builder depends on, so an
 * upstream change fails here instead of turning into plausible wrong rows:
 * `cf_type=ISO` makes `AUS` Australia (UNHCR's own code for Austria is `AUS`)
 * on the data endpoints and on nowcasting, a paired year window is honored
 * while a lone `yearFrom` is ignored, and rows arrive year-ascending.
 * @module tests/live/upstream-behavior.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { buildUrl, UnhcrApiService } from '@/services/unhcr/unhcr-api-service.js';

const service = new UnhcrApiService({
  config: { requestsPerSecond: 1, maxRows: 10_000, cacheMaxBytes: 0 },
});

afterAll(() => service.dispose());

const sortedCopy = (years: readonly number[]) => [...years].sort((a, b) => a - b);

describe('UNHCR API behaviors the request builder relies on', () => {
  it('matches ISO3 under cf_type=ISO and honors a paired year window, rows year-ascending', async () => {
    const { rows, complete } = await service.population(
      {
        origin: { mode: 'summed', codes: [] },
        asylum: { mode: 'listed', codes: ['AUS'] },
        yearFrom: 2020,
        yearTo: 2022,
      },
      createMockContext(),
    );
    expect(complete).toBe(true);
    expect(rows.map((row) => row.year)).toEqual([2020, 2021, 2022]);
    for (const row of rows) {
      expect(row).toMatchObject({ asylum_iso3: 'AUS', asylum_name: 'Australia' });
    }
  });

  it('ignores a lone yearFrom and returns the full history, year-ascending', async () => {
    // buildUrl refuses a lone bound, so the stray parameter is added by hand.
    const url = new URL(buildUrl('population', { coo: ['SYR'], limit: 100, page: 1 }));
    url.searchParams.set('yearFrom', '2024');
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'unhcr-refugees-mcp-server (+https://github.com/cyanheads/unhcr-refugees-mcp-server)',
      },
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { items: { year: unknown }[] };
    const years = body.items.map((item) => Number(item.year));
    expect(years.some((year) => year < 2024)).toBe(true);
    expect(years).toContain(2024);
    expect(years).toEqual(sortedCopy(years));
  });

  it('matches ISO3 on nowcasting under cf_type=ISO', async () => {
    const { rows } = await service.nowcast(
      { mode: 'listed', codes: ['AUS', 'DEU'] },
      createMockContext(),
    );
    // Without cf_type, AUS would match Austria and DEU nothing.
    const codes = rows.map((row) => row.asylum_iso3);
    expect(codes).toContain('DEU');
    expect(codes.filter((code) => code !== 'AUS' && code !== 'DEU')).toEqual([]);
    expect(rows.map((row) => row.asylum_name)).not.toContain('Austria');
  });
});
