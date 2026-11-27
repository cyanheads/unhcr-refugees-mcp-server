# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-11-27 · ⚠️ Breaking

UNHCR results identify their reporting periods and keep those dates through staged queries. Shared reads recover from transient outages within each caller’s budget.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-11-25 · ⚠️ Breaking

Asylum tools carry UNHCR footnotes, list inputs accept strings, name_contains resolves common English country names, and concurrent first stagings share one canvas. unhcr_dataframe_query now refuses 35 metadata-view names used as identifiers (breaking).

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-11-04 · ⚠️ Breaking

Count inputs share one clamped cap and a 25-row default, the SQL byte budget and its chunk fields are removed, footnotes and the nowcast follow the inline cut, and the server publishes its first agent skill.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-10-20 · ⚠️ Breaking

Bounded SQL results and source completeness

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-10-03

Framework adoption adds request IDs and clearer argument recovery, and registry installs launch the selected transport.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-26

First public release: nine tools (one opt-in) over UNHCR's Refugee Population Statistics Database for displacement stocks, demographics, asylum applications and decisions, and durable solutions, with results too large to return inline staged as DuckDB dataframes for SQL.
