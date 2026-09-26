/**
 * @fileoverview Value and identity normalization for UNHCR rows. One upstream
 * row mixes integers, numeric strings (`"0"`), and `"-"` — UNHCR's marker for a
 * category that is not applicable or was not collected. A number or numeric
 * string becomes a number, `"-"` becomes `null`, and anything else becomes
 * `null` and is counted so the tool can say so rather than invent a zero.
 * @module services/unhcr/normalize
 */

import type { DataRow, RawRow, RowIdentity } from './types.js';

/** Running count of upstream values that were neither numeric nor `"-"`. */
export interface ValueTally {
  unexpected: number;
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** Normalize one count cell. */
export function toCount(value: unknown, tally: ValueTally): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    tally.unexpected++;
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '-') return null;
    if (NUMERIC.test(trimmed)) return Number(trimmed);
  }
  tally.unexpected++;
  return null;
}

/** Normalize a year cell; a year that is not an integer is a malformed row. */
export function toYear(value: unknown): number | undefined {
  const year = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof year === 'number' && Number.isInteger(year) ? year : undefined;
}

/** Normalize a code or name cell: trimmed, with `""` and `"-"` meaning summed. */
export function toIdentityText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

/** Normalize the seven identity columns of a data row. */
export function toIdentity(raw: RawRow, year: number): RowIdentity {
  return {
    year,
    origin_iso3: toIdentityText(raw.coo_iso),
    origin_unhcr_code: toIdentityText(raw.coo),
    origin_name: toIdentityText(raw.coo_name),
    asylum_iso3: toIdentityText(raw.coa_iso),
    asylum_unhcr_code: toIdentityText(raw.coa),
    asylum_name: toIdentityText(raw.coa_name),
  };
}

/** Copy just the seven identity columns of a normalized row. */
export function pickIdentity(row: RowIdentity): RowIdentity {
  return {
    year: row.year,
    origin_iso3: row.origin_iso3,
    origin_unhcr_code: row.origin_unhcr_code,
    origin_name: row.origin_name,
    asylum_iso3: row.asylum_iso3,
    asylum_unhcr_code: row.asylum_unhcr_code,
    asylum_name: row.asylum_name,
  };
}

/**
 * Normalize one data row: identity plus the listed count columns. Returns
 * `undefined` for a row with no usable year, which cannot be placed in a
 * series; the caller counts such rows apart from the tallied values.
 */
export function toDataRow<F extends string>(
  raw: RawRow,
  fields: readonly F[],
  tally: ValueTally,
): DataRow<F> | undefined {
  const year = toYear(raw.year);
  if (year === undefined) return;
  const counts = {} as Record<F, number | null>;
  for (const field of fields) counts[field] = toCount(raw[field], tally);
  return { ...toIdentity(raw, year), ...counts };
}
