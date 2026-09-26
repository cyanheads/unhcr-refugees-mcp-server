/**
 * @fileoverview Tests that every unhcr_get_* data tool reports an upstream row
 * with no usable year the way it handles it: left out of the result and
 * counted in its own `data_notes` line on both surfaces, never folded into the
 * count of values "reported as null", and still counted among the upstream
 * rows a capped fetch's partial-result notice names.
 * @module tests/tools/yearless-rows.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAsylumApplicationsTool } from '@/mcp-server/tools/definitions/get-asylum-applications.tool.js';
import { getAsylumDecisionsTool } from '@/mcp-server/tools/definitions/get-asylum-decisions.tool.js';
import { getDemographicsTool } from '@/mcp-server/tools/definitions/get-demographics.tool.js';
import { getPopulationTool } from '@/mcp-server/tools/definitions/get-population.tool.js';
import { getSolutionsTool } from '@/mcp-server/tools/definitions/get-solutions.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import type { RawRow } from '../fixtures/unhcr.js';
import {
  applicationRow,
  decisionRow,
  demographicsRow,
  envelope,
  populationRow,
  solutionsRow,
} from '../fixtures/unhcr.js';
import type { FakeUnhcr } from '../helpers/fake-unhcr.js';
import { structuredOf, textOf } from '../helpers/results.js';
import { initFakeUpstream } from '../helpers/services.js';

let fake: FakeUnhcr;

beforeEach(() => {
  ({ fake } = initFakeUpstream());
  initCanvasBridge(undefined);
});

afterEach(() => {
  disposeUnhcrService();
});

const scope = { origin: 'SYR', asylum: 'DEU' };

/** Each data tool, its endpoint, and one fixture row it keeps. */
const DATA_TOOLS = [
  {
    tool: 'unhcr_get_population',
    endpoint: 'population',
    row: populationRow(2024, 'SYR', 'DEU', [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    run: () => runToolContract(getPopulationTool, scope),
  },
  {
    tool: 'unhcr_get_solutions',
    endpoint: 'solutions',
    row: solutionsRow(2024, 'SYR', 'DEU', [1, 2, 3, 4]),
    run: () => runToolContract(getSolutionsTool, scope),
  },
  {
    tool: 'unhcr_get_demographics',
    endpoint: 'demographics',
    row: demographicsRow(2024, 'SYR', 'DEU', 'REF', 30, {
      f: [1, 2, 3, 4, 5, 0, 15],
      m: [1, 2, 3, 4, 5, 0, 15],
    }),
    run: () => runToolContract(getDemographicsTool, scope),
  },
  {
    tool: 'unhcr_get_asylum_applications',
    endpoint: 'asylum-applications',
    row: applicationRow(2024, 'SYR', 'DEU', ['G', 'N', 'FI', 'P', 100]),
    run: () => runToolContract(getAsylumApplicationsTool, scope),
  },
  {
    tool: 'unhcr_get_asylum_decisions',
    endpoint: 'asylum-decisions',
    row: decisionRow(2024, 'SYR', 'DEU', ['G', 'FI', 'P'], [10, 5, 5, 2, 22]),
    run: () => runToolContract(getAsylumDecisionsTool, scope),
  },
];

/**
 * Answer the tool's data request with its fixture row plus a year-less copy.
 * The fake's own year filter would drop the year-less row, so the page is
 * served directly; `maxPages` above 1 makes a row cap of one page stop there.
 */
function serveWithYearlessCopy(endpoint: string, row: RawRow, maxPages = 1): void {
  fake.intercept({
    endpoint,
    matches: (params) => params.has('yearFrom'),
    respond: () => Response.json(envelope([row, { ...row, year: 'unknown' }], { maxPages })),
  });
}

describe('an upstream row with no usable year', () => {
  it.each(DATA_TOOLS)(
    '$tool leaves it out and says so in its own note on both surfaces',
    async ({ endpoint, row, run }) => {
      serveWithYearlessCopy(endpoint, row);
      const result = await run();
      const structured = structuredOf(result);
      expect(structured.rows).toEqual([expect.objectContaining({ year: 2024 })]);

      const note = '1 upstream row(s) carried no usable year and were left out.';
      const notes = structured.data_notes as string[];
      expect(notes).toContain(note);
      expect(notes.some((line) => line.includes('neither a number'))).toBe(false);
      const text = textOf(result.content);
      expect(text).toContain(`- ${note}`);
      expect(text).not.toContain('neither a number');
    },
  );

  it.each(DATA_TOOLS)(
    '$tool counts it among the upstream rows a capped fetch names, on both surfaces',
    async ({ endpoint, row, run }) => {
      disposeUnhcrService();
      ({ fake } = initFakeUpstream({ config: { maxRows: 10_000 } }));
      serveWithYearlessCopy(endpoint, row, 2);
      const result = await run();
      const structured = structuredOf(result);
      expect(structured).toMatchObject({ complete: false, total_rows: 1 });

      const partial =
        "The fetch stopped at the server's row cap after 2 upstream rows, so this result is partial.";
      expect(structured.notice).toContain(partial);
      expect(textOf(result.content)).toContain(partial);
    },
  );
});
