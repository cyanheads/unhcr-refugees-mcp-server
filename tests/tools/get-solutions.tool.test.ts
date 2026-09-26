/**
 * @fileoverview Tests for unhcr_get_solutions over the fake UNHCR upstream and
 * a real in-memory DuckDB canvas: flows on both surfaces, footnotes matched on
 * the solutions population types only, every declared error reason, sorting,
 * staging, the row cap, and form-client inputs.
 * @module tests/tools/get-solutions.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSolutionsTool } from '@/mcp-server/tools/definitions/get-solutions.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import type { FakeUnhcr } from '../helpers/fake-unhcr.js';
import { errorOf, structuredOf, textOf } from '../helpers/results.js';
import { createTestCanvas, initFakeUpstream, shutdownCanvas } from '../helpers/services.js';

type Input = z.input<typeof getSolutionsTool.input>;

let canvas: DataCanvas;
let fake: FakeUnhcr;

beforeAll(() => {
  canvas = createTestCanvas();
});

afterAll(async () => {
  await shutdownCanvas(canvas);
});

beforeEach(() => {
  ({ fake } = initFakeUpstream());
  initCanvasBridge(canvas, { ttlMs: 60_000 });
});

afterEach(() => {
  disposeUnhcrService();
});

const context = () => createMockContext({ errors: getSolutionsTool.errors });

const call = (input: Input, ctx = context()) =>
  getSolutionsTool.handler(getSolutionsTool.input.parse(input), ctx);

const syrPairs2025: Input = { origin: 'SYR', expand: 'asylum', year_from: 2025, year_to: 2025 };

describe('success, both surfaces', () => {
  it('returns an under-cap page of flows through the production enrichment parse', async () => {
    const result = await runToolContract(getSolutionsTool, { origin: 'SYR' });
    const structured = structuredOf(result);
    expect(structured).not.toHaveProperty('notice');
    expect(structured).toMatchObject({
      total_rows: 3,
      complete: true,
      measure: 'flow',
      latest_year: 2025,
      applied_scope: {
        origin: { mode: 'listed', codes: ['SYR'] },
        asylum: { mode: 'summed', codes: [] },
        year_from: 1959,
        year_to: 2025,
      },
      attribution: { providers: [] },
      footnotes: [
        expect.objectContaining({
          origin_iso3: 'SYR',
          population_types: ['RET', 'RDP'],
          rows_matched: 2,
        }),
      ],
      footnotes_total: 1,
    });
    expect((structured.rows as Record<string, unknown>[])[1]).toEqual({
      year: 2024,
      origin_iso3: 'SYR',
      origin_unhcr_code: 'SYR',
      origin_name: 'Syrian Arab Rep.',
      asylum_iso3: null,
      asylum_unhcr_code: null,
      asylum_name: null,
      returned_refugees: 512718,
      resettlement: 25532,
      naturalisation: 17595,
      returned_idps: 513896,
    });
    const notes = structured.data_notes as string[];
    expect(notes[0]).toBe(
      'Counts are flows: events during each calendar year, not people present at year end.',
    );
    expect(notes).toContain('Naturalisation is an incomplete proxy for local integration.');
    expect(
      notes.some((note) =>
        note.startsWith('The asylum country means something different per column'),
      ),
    ).toBe(true);

    const text = textOf(result.content);
    for (const expected of [
      '**Measure:** flow · **Latest year:** 2025 · **Rows:** 3 shown of 3 total · **Complete:** yes',
      '| Year | Origin | Asylum | Returned refugees | Resettlement | Naturalisation | Returned IDPs |',
      '| 2024 | Syrian Arab Rep. [SYR · UNHCR SYR] | all (summed) | 512,718 | 25,532 | 17,595 | 513,896 |',
      '### Footnotes (1 of 1)',
      '> Return figures for Syria combine government and UNHCR operational estimates.',
      'Source: UNHCR Refugee Population Statistics Database (CC BY 4.0)',
    ]) {
      expect(text).toContain(expected);
    }
    expect(fake.urlsFor('unrwa')).toHaveLength(0);
    expect(fake.urlsFor('idmc')).toHaveLength(0);
    expect(fake.urlsFor('nowcasting')).toHaveLength(0);
  });

  it('returns a zero-result page with the both-dimensions notice through the production enrichment parse', async () => {
    const result = await runToolContract(getSolutionsTool, { origin: 'SYR', asylum: 'JPN' });
    const notice =
      'No rows for origin SYR in asylum JPN in 1959–2025. Origin is where people fled from and asylum where they sought or hold protection (for returns, the country they returned from); swapping them is the common miss.';
    expect(structuredOf(result)).toMatchObject({
      rows: [],
      total_rows: 0,
      footnotes: [],
      footnotes_total: 0,
      notice,
    });
    const text = textOf(result.content);
    expect(text).toContain('_No rows._');
    expect(text).toContain(`> ${notice}`);
  });

  it('names a single-year window as one year in the empty notice and the scope line', async () => {
    const result = await runToolContract(getSolutionsTool, {
      origin: 'SYR',
      asylum: 'JPN',
      year_from: 2025,
      year_to: 2025,
    });
    const notice = String(structuredOf(result).notice);
    expect(notice).toContain('No rows for origin SYR in asylum JPN in 2025.');
    const text = textOf(result.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Scope:** origin listed SYR · asylum listed JPN · years 2025\n');
    expect(`${notice}\n${text}`).not.toContain('2025–2025');
  });

  it('returns an over-cap page, staging the full result with the solutions columns', async () => {
    const result = await runToolContract(getSolutionsTool, { ...syrPairs2025, limit: 2 });
    const structured = structuredOf(result);
    const dataset = structured.dataset as { name: string };
    expect(structured).toMatchObject({ total_rows: 5, truncated: true, shown: 2, cap: 2 });
    expect(structured.notice).toContain(`Full set staged as ${dataset.name} (5 rows).`);

    const ctx = context();
    const staged = await call({ ...syrPairs2025, limit: 2 }, ctx);
    const { result: query } = await getCanvasBridge()!.query(
      ctx,
      `SELECT asylum_iso3, resettlement, typeof(naturalisation) AS nat_type, asylum_unhcr_region FROM ${staged.dataset?.name} ORDER BY asylum_iso3 LIMIT 1`,
      { rowLimit: 10 },
    );
    expect(query.rows).toEqual([
      { asylum_iso3: 'DEU', resettlement: 209, nat_type: 'INTEGER', asylum_unhcr_region: 'Europe' },
    ]);
    expect(query.columns).not.toContain('unrwa_refugees');
  });

  it('keeps "-" as null (not collected), never zero, and renders it as an em dash', async () => {
    const result = await call({ year_from: 1959, year_to: 1959 });
    expect(result.rows).toEqual([
      expect.objectContaining({
        year: 1959,
        returned_refugees: null,
        resettlement: 3043,
        naturalisation: null,
        returned_idps: null,
      }),
    ]);
    expect(textOf(getSolutionsTool.format!(result))).toContain(
      '| 1959 | all (summed) | all (summed) | — | 3,043 | — | — |',
    );
  });

  it('does not attach population-only footnotes', async () => {
    // SYR→DEU 2025 carries resettlement only: neither the Germany refugees caveat
    // nor the Syria returns caveat applies.
    const result = await call({ origin: 'SYR', asylum: 'DEU', year_from: 2025 });
    expect(result.footnotes).toEqual([]);
    expect(result.footnotes_total).toBe(0);
  });

  it('attaches a footnote only to rows with a nonzero count in one of its types, on both surfaces', async () => {
    // Origin SYR, every asylum country, 2024: JOR, LBN, and TUR report refugee
    // returns, SYR→SYR IDP returns, and DEU resettlement only.
    const result = await runToolContract(getSolutionsTool, {
      origin: 'SYR',
      expand: 'asylum',
      year_from: 2024,
      year_to: 2024,
    });
    const structured = structuredOf(result);
    expect(structured).toMatchObject({
      total_rows: 5,
      footnotes: [
        {
          text: 'Return figures for Syria combine government and UNHCR operational estimates.',
          population_types: ['RET', 'RDP'],
          rows_matched: 4,
        },
      ],
      footnotes_total: 1,
    });
    expect(textOf(result.content)).toContain(
      '- **2024 - 2025** · origin SYR, any asylum · types RET, RDP · 4 rows matched',
    );
  });
});

describe('inputs and sorting', () => {
  it('sorts by a count field largest first, nulls last, ties by asylum', async () => {
    const result = await call({ ...syrPairs2025, sort_by: 'resettlement' });
    expect(result.rows.map((row) => [row.asylum_iso3, row.resettlement])).toEqual([
      ['DEU', 209],
      ['JOR', null],
      ['LBN', null],
      ['SYR', null],
      ['TUR', null],
    ]);
  });

  it('treats form-client blanks as unset', async () => {
    const result = await runToolContract(getSolutionsTool, {
      origin: '',
      asylum: '',
      expand: '' as 'none',
      sort_by: '' as 'year',
      year_from: '' as unknown as number,
      year_to: '' as unknown as number,
    });
    expect(structuredOf(result).applied_scope).toMatchObject({
      origin: { mode: 'summed' },
      asylum: { mode: 'summed' },
      year_from: 1959,
      year_to: 2025,
    });
  });

  it.each([
    ['a population-only sort field', { sort_by: 'refugees' as 'year' }],
    ['year_from below 1900', { year_from: 1800 }],
    ['limit above 500', { limit: 1000 }],
  ])('rejects %s as invalid params', async (_label, input) => {
    expect(errorOf(await runToolContract(getSolutionsTool, input as Input)).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a capped fetch as complete: false on both surfaces, naming the upstream rows fetched', async () => {
    disposeUnhcrService();
    initFakeUpstream({ pageSize: { solutions: 2 }, config: { maxRows: 10_000 } });
    const result = await runToolContract(getSolutionsTool, syrPairs2025);
    const structured = structuredOf(result);
    expect(structured).toMatchObject({ complete: false, total_rows: 2 });
    const notice = String(structured.notice);
    expect(notice).toContain("The fetch stopped at the server's row cap after 2 upstream rows");
    expect(textOf(result.content)).toContain(`> ${notice}`);
  });
});

describe('declared errors, by reason', () => {
  it('fails unknown_country_code with an exact suggestion for a UNHCR code', async () => {
    const error = errorOf(await runToolContract(getSolutionsTool, { asylum: 'ARE' }));
    // ARE is Egypt in UNHCR's scheme but the United Arab Emirates in ISO3, absent from this table.
    expect(error.data).toMatchObject({
      reason: 'unknown_country_code',
      recovery: { hint: "ARE is UNHCR's code for Egypt; pass EGY." },
    });
  });

  it('fails invalid_year_window without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getSolutionsTool, { year_from: 2025, year_to: 2024 }),
    );
    expect(error.data?.reason).toBe('invalid_year_window');
    expect(fake.calls).toHaveLength(0);
  });

  it('fails conflicting_scope without any upstream request', async () => {
    const error = errorOf(
      await runToolContract(getSolutionsTool, { asylum: 'DEU', expand: 'asylum' }),
    );
    expect(error.data).toMatchObject({ reason: 'conflicting_scope', conflicts: ['asylum'] });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails year_out_of_coverage naming the solutions span, with no nowcast option', async () => {
    const before = errorOf(await runToolContract(getSolutionsTool, { year_to: 1958 }));
    expect(before.message).toBe(
      'Solutions data covers 1959–2025; the requested window (through 1958) lies outside it.',
    );
    const after = errorOf(await runToolContract(getSolutionsTool, { year_from: 2026 }));
    expect(after.data?.reason).toBe('year_out_of_coverage');
    expect(after.data?.recovery?.hint).toContain('Solutions data covers 1959–2025');
    expect(after.data?.recovery?.hint).not.toContain('include_nowcast');
  });

  it('names a single-year window outside coverage as one year', async () => {
    const result = await runToolContract(getSolutionsTool, { year_from: 2030, year_to: 2030 });
    const message = 'Solutions data covers 1959–2025; the requested window (2030) lies outside it.';
    expect(errorOf(result)).toMatchObject({ data: { reason: 'year_out_of_coverage' }, message });
    expect(textOf(result.content)).toContain(message);
  });

  it('fails upstream_busy with the tool’s recovery when UNHCR answers 429', async () => {
    fake.intercept({
      endpoint: 'solutions',
      respond: () => new Response('', { status: 429, headers: { 'retry-after': '45' } }),
    });
    const error = errorOf(await runToolContract(getSolutionsTool, { origin: 'SYR' }));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'upstream_busy',
        retryAfter: 45,
        retryable: true,
        recovery: {
          hint: 'Wait the retryAfter seconds the error carries, then retry; a narrower year window or no expand needs fewer upstream requests.',
        },
      },
    });
  });
});
