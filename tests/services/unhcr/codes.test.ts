/**
 * @fileoverview Tests for the static vocabulary: population types and the
 * output columns carrying them, asylum code lists and the filter vocabularies
 * drawn from them, every dataset in the coverage table, the demographic and
 * folded types, and the attribution UNHCR's terms fix.
 * @module tests/services/unhcr/codes.test
 */

import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STAGES,
  ASYLUM_CODES,
  ATTRIBUTION_SOURCE,
  asylumCodeLabel,
  DATA_LICENSE,
  DATASETS,
  DECISION_LEVELS,
  DEMOGRAPHIC_TYPES,
  FOLDED_TYPES,
  POPULATION_TYPES,
  TERMS_URL,
} from '@/services/unhcr/codes.js';
import { POPULATION_FIELDS, SOLUTIONS_FIELDS } from '@/services/unhcr/types.js';

describe('attribution', () => {
  it('uses the source string and terms URL UNHCR’s Terms of Use fix', () => {
    expect(ATTRIBUTION_SOURCE).toBe('UNHCR Refugee Population Statistics Database');
    expect(DATA_LICENSE).toBe('CC BY 4.0');
    expect(TERMS_URL).toBe(
      'https://www.unhcr.org/what-we-do/data-and-publications/data-and-statistics/terms-use-datasets',
    );
  });
});

describe('POPULATION_TYPES', () => {
  it('lists the thirteen types in methodology order', () => {
    expect(POPULATION_TYPES.map((type) => type.code)).toEqual([
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
      'RST',
      'NAT',
    ]);
  });

  it('folds ROC into refugees and IOC into idps, with no column of their own', () => {
    const byCode = new Map(POPULATION_TYPES.map((type) => [type.code, type]));
    expect(byCode.get('ROC')?.field).toBeNull();
    expect(byCode.get('IOC')?.field).toBeNull();
    expect(byCode.get('ROC')?.definition).toContain('Counted inside refugees');
    expect(byCode.get('IOC')?.definition).toContain('Counted inside idps');
  });

  it('names only output columns the population and solutions tools actually return', () => {
    const columns = new Set<string>([...POPULATION_FIELDS, ...SOLUTIONS_FIELDS]);
    for (const type of POPULATION_TYPES) {
      if (type.field !== null) expect(columns.has(type.field), type.code).toBe(true);
    }
  });

  it('marks returns, resettlement, and naturalisation as flows and the rest as stocks', () => {
    const flows = POPULATION_TYPES.filter((type) => type.measure === 'flow').map((t) => t.code);
    expect(flows).toEqual(['RET', 'RDP', 'RST', 'NAT']);
  });

  it('gives every type a label and a definition', () => {
    for (const type of POPULATION_TYPES) {
      expect(type.label.length, type.code).toBeGreaterThan(0);
      expect(type.definition.length, type.code).toBeGreaterThan(20);
    }
  });
});

describe('ASYLUM_CODES', () => {
  it('lists the documented authority and unit codes', () => {
    expect(ASYLUM_CODES.authority.map((entry) => entry.code)).toEqual(['G', 'J', 'U']);
    expect(ASYLUM_CODES.unit.map((entry) => entry.code)).toEqual(['P', 'C']);
  });

  it('flags only the undocumented application stages V and RA', () => {
    const undocumented = ASYLUM_CODES.application_stage
      .filter((entry) => !entry.documented)
      .map((entry) => entry.code);
    expect(undocumented).toEqual(['V', 'RA']);
    expect(ASYLUM_CODES.application_stage.map((entry) => entry.code)).toEqual([
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
    ]);
  });

  it('lists the fourteen decision levels, all documented', () => {
    expect(ASYLUM_CODES.decision_level).toHaveLength(14);
    expect(ASYLUM_CODES.decision_level.every((entry) => entry.documented)).toBe(true);
  });

  it('keeps codes unique within each list', () => {
    for (const [list, entries] of Object.entries(ASYLUM_CODES)) {
      const codes = entries.map((entry) => entry.code);
      expect(new Set(codes).size, list).toBe(codes.length);
    }
  });
});

describe('DATASETS', () => {
  it('routes the Wave 1 datasets to the tools that return their figures', () => {
    const byDataset = new Map(DATASETS.map((info) => [info.dataset, info]));
    expect(byDataset.get('population')).toMatchObject({
      tool: 'unhcr_get_population',
      measure: 'stock',
    });
    expect(byDataset.get('solutions')).toMatchObject({
      tool: 'unhcr_get_solutions',
      measure: 'flow',
    });
    expect(byDataset.get('unrwa')?.tool).toBe('unhcr_get_population');
    expect(byDataset.get('idmc')?.tool).toBe('unhcr_get_population');
    expect(byDataset.get('footnotes')).toMatchObject({
      tool: 'unhcr_get_population',
      measure: null,
    });
  });

  it('keeps dataset keys unique', () => {
    const keys = DATASETS.map((info) => info.dataset);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('DATASETS, all eight', () => {
  it('lists every dataset once, in coverage order, with the endpoint its span is probed from', () => {
    expect(
      DATASETS.map(({ dataset, endpoint, tool, measure }) => [dataset, endpoint, tool, measure]),
    ).toEqual([
      ['population', 'population', 'unhcr_get_population', 'stock'],
      ['demographics', 'demographics', 'unhcr_get_demographics', 'stock'],
      ['asylum_applications', 'asylum-applications', 'unhcr_get_asylum_applications', 'flow'],
      ['asylum_decisions', 'asylum-decisions', 'unhcr_get_asylum_decisions', 'flow'],
      ['solutions', 'solutions', 'unhcr_get_solutions', 'flow'],
      ['unrwa', 'unrwa', 'unhcr_get_population', 'stock'],
      ['idmc', 'idmc', 'unhcr_get_population', 'stock'],
      ['footnotes', 'footnotes', 'unhcr_get_population', null],
    ]);
    for (const info of DATASETS) expect(info.note.length, info.dataset).toBeGreaterThan(20);
  });
});

describe('asylum and demographics filter vocabularies', () => {
  it('accepts exactly the published application-stage and decision-level codes', () => {
    expect([...APPLICATION_STAGES]).toEqual(ASYLUM_CODES.application_stage.map((c) => c.code));
    expect([...DECISION_LEVELS]).toEqual(ASYLUM_CODES.decision_level.map((c) => c.code));
  });

  it('decodes a code within its own list only, and nothing for a code no list carries', () => {
    expect(asylumCodeLabel('application_stage', 'NA')).toBe('New and appeal (reported together)');
    expect(asylumCodeLabel('decision_level', 'NA')).toBe('New applications');
    expect(asylumCodeLabel('unit', 'C')).toBe('Cases');
    expect(asylumCodeLabel('decision_level', 'V')).toBeUndefined();
    expect(asylumCodeLabel('application_stage', 'ZZ')).toBeUndefined();
  });

  it('breaks demographics down by the types that have a column, minus resettlement and naturalisation', () => {
    const withColumn = POPULATION_TYPES.filter((type) => type.field !== null).map((t) => t.code);
    expect([...DEMOGRAPHIC_TYPES]).toEqual(
      withColumn.filter((code) => code !== 'RST' && code !== 'NAT'),
    );
  });

  it('folds ROC into REF and IOC into IDP, the types whose columns count them', () => {
    expect([...FOLDED_TYPES]).toEqual([
      ['REF', 'ROC'],
      ['IDP', 'IOC'],
    ]);
    const byCode = new Map(POPULATION_TYPES.map((type) => [type.code, type]));
    for (const [carrier, folded] of FOLDED_TYPES) {
      expect(byCode.get(folded)?.field).toBeNull();
      expect(byCode.get(carrier)?.field).not.toBeNull();
    }
  });
});
