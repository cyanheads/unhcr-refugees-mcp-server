---
name: unhcr-refugees-guide
description: Gates for answering displacement and asylum questions with the unhcr_* tools of unhcr-refugees-mcp-server — which columns a total sums, stateless people under origin XXA, the two Palestine refugee series, the nowcast's missing origin, bureau and EU totals in SQL, stage and decision-level filters that drop countries, switching units, demographic shares, solutions start years, and footnotes. Use before ranking, summing, or comparing UNHCR figures across countries, years, or tools.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

`unhcr-refugees-mcp-server` serves UNHCR's Refugee Population Statistics Database, keyless. It covers year-end displacement stocks, sex and age breakdowns, asylum applications and decisions, and durable solutions, with UNRWA's Palestine refugees and IDMC's conflict-IDP estimate beside population rows. Every series is annual except the nowcast, a single current-month estimate of refugees and asylum-seekers by asylum country. Out of reach: UNHCR's mid-year statistics, any place below the country (camps, provinces), ethnic groups as a dimension, and the country refugees were resettled from.

## Identifiers

| Identifier | Where it comes from |
|:--|:--|
| Country (ISO3) | `unhcr_list_reference` topic `countries` with `name_contains`; `stateless` finds `XXA`, the non-country origin code |
| UNHCR regional bureau | `unhcr_list_reference` topic `regions`. Staged tables carry the same names in `origin_unhcr_region` and `asylum_unhcr_region`, and UN subregions (`Western Europe`, `Western Asia`, …) in `origin_unsd_region` and `asylum_unsd_region`. No column marks the EU or any other bloc |
| `df_XXXXX_XXXXX` | `dataset.name` on a data result that overflowed `limit` or set `stage`, `nowcast_dataset.name` for the nowcast, or your own `register_as` |

## Gates

**Name the columns a total sums.**
- `refugees` leaves out `asylum_seekers` and `oip`. A count of everyone displaced across borders from a country adds both.
- Everyone displaced from a country also includes the `idps` on its origin = asylum row: Syria's 5.5M IDPs at end-2025 sit on SYR→SYR, beside the refugees abroad.
- Take IDPs from one series, never both. `idmc_conflict_idps` is the one UNHCR's displacement headline uses (data_notes says so); `idps` counts the IDPs UNHCR protects or assists.
- `hst` (host community), `ooc`, and `stateless` are not displacement categories, and the `returned_*` columns are flows, so keep all of them out of a displacement total. Say which columns you added.
- In SQL, a row-wise `+` is null when any term is null, and `oip` is null on almost every pair row. Wrap each term in `COALESCE(col, 0)` and say you read not-applicable as zero.

**Stateless people sit under origin XXA.** Each stateless count is on an origin `XXA` row whose asylum is the country of residence. In every year from 2005 to 2025, the world stateless total equals the XXA total. To count a stateless population, query origin XXA with that country as asylum; setting origin to the group's country of origin finds none. No ethnic group is a dimension, and a group's name appears only in footnote text, as in Myanmar's caveat on its stateless Rohingya. Displaced stateless people are counted twice. At end-2025 Bangladesh carries 1.18M refugees from Myanmar (origin MMR) and 1.18M stateless people (origin XXA): the same Rohingya in both columns. Myanmar's stateless figure includes stateless Rohingya IDPs. Never add `stateless` to `refugees` or `idps` for the same country.

**Palestine refugees are two disjoint series.** UNRWA's registered refugees are `unrwa_refugees` on origin PSE rows for asylum PSE, JOR, LBN, SYR, and UNK, and on world rows; `refugees` is 0 or null there. Palestinians under UNHCR's mandate are `refugees` on origin PSE rows elsewhere (Greece, Belgium, Iraq, …). A Palestine refugee total, or a world displacement total, adds the two.

**The nowcast answers "now" for a host country only.** It has no origin dimension and no history: one current-month estimate per asylum country, all origins together (`unhcr_list_reference` topic `coverage` names the month). "How many Syrians are in Türkiye now" has no answer past the latest year-end row, so say so rather than quoting Türkiye's nowcast. The nowcast and the year-end stock count largely the same people. Report the two side by side with their dates, never add or average them, and never read their difference as arrivals. The nowcast stages as its own table, so keep it out of year-end SQL.

**Bureau and bloc totals come from SQL.** No input filters by region, and listed codes come back one row each, never summed.
- For a UNHCR bureau, expand the dimension, stage, and `GROUP BY asylum_unhcr_region` (hosts) or `origin_unhcr_region` (origins).
- For the EU or any other bloc, list the member ISO3 codes yourself, then sum in SQL. The Europe bureau held 54 countries in 2026, the UN subregions split Europe four ways, and Western Asia straddles the Europe and Middle East bureaus.
- Expand only the dimension you group or rank by. Per-host refugees and IDPs need only expand asylum (180 rows for 2025), not expand both (6,302 origin–asylum pairs for 2025). Both give the same bureau totals.

**A headline filter can drop whole countries.**
- `stages` `["N"]` keeps only new applications reported on their own. Countries that report new and repeat claims together (`NR`) disappear: Bulgaria in every year 2021–2025, South Africa in 2023–2025.
- `decision_levels` `["FI"]` drops countries that report first instance and appeal together (`FA`): Austria for every origin in every year 2016–2025. Others switch between `FI` and `FA` from year to year; five EU states did in their Afghan decisions over 2016–2025.
- Before a cross-country figure, read which codes each country reports (`split_by`, or the staged code columns in SQL). Then either keep the combined code for those countries or leave them out, and say which you did.

**A country's unit can switch between years.** The US reports USCIS applications (`IN`) in cases and immigration-court applications (`EO`) in persons in 2016–2020 and 2025, but only persons in 2021–2024. A persons-only US series therefore covers different things in different years. Afghan decisions in Belgium and Finland include case-counted rows too. Report cases beside persons, never added together. In SQL, `GROUP BY unit` or filter `unit = 'persons'`, and say which.

**Demographic shares come from the broken-down part.** `total` includes people with no sex or age breakdown. Compute a sex share over `female_total + male_total`, and an age share over that sum minus the two `*_unknown_age` bands. Report `sex_disaggregated_share` as coverage. At end-2025, 90% of world refugees are broken down by sex, and 2.3M of them have a known sex but no age. Never divide a demographics band by a `unhcr_get_population` count: world stateless at end-2025 is 2.88M in demographics and 4.48M in population.

**Solutions columns start in different years, and resettlement has no departure country.** At world level, resettlement runs from 1959, refugee returns from 1965, naturalisation from 1990, and IDP returns from 1997. Earlier years are null, not zero, so start each trend at its column's first non-null year. Resettlement is recorded only against the destination, and first-asylum hosts (Türkiye, Lebanon, Pakistan, Uganda, …) carry null resettlement. No tool says which country refugees were resettled from. The `returned_refugees` and `returned_idps` columns on population rows are the same series as in `unhcr_get_solutions`, so count them once.

**Read a footnote before applying it.** A caveat naming only an asylum country attaches to every origin's row there. Germany's caveat about arrivals from Ukraine, for example, attaches to the Syrian row in Germany. A call returns at most 20 caveats, those on its inline rows first. When `footnotes_total` exceeds the number returned, list the origin and asylum codes of the rows you report, split across calls until each call's `footnotes_total` equals the number it returns: at end-2025 the top 30 Syrian hosts carry 17 caveats, the top 60 carry 26.

## Workflows

**SQL over staged results.** A result larger than `limit`, or one called with `stage`, is staged as a `df_XXXXX_XXXXX` table named in `dataset.name` (the nowcast's in `nowcast_dataset.name`). Call `unhcr_dataframe_describe` with that name for the columns before writing SQL, then `unhcr_dataframe_query` with one read-only SELECT. Aggregate in SQL rather than reading rows out, since the query returns only a short preview of rows unless you ask for more. Join tables from different tools on `year` and the ISO3 columns. On the hosted instance listing is off and every caller shares one staging budget. Keep each name you are given, and re-run the producing call when a table comes back `missing_table`.

**Bureau totals.** `unhcr_get_population` with expand asylum and the year, then:

```sql
SELECT asylum_unhcr_region AS bureau, SUM(refugees) AS refugees_hosted,
       SUM(idps) AS idps, SUM(idmc_conflict_idps) AS idmc_conflict_idps
FROM df_XXXXX_XXXXX
GROUP BY 1 ORDER BY 1
```

The null-bureau group holds Unknown (`UNK`) and IDMC's Abyei Area (`AB9`), which has no UNHCR bureau.

**Bloc recognition rates** (Afghans in the EU, 2016–2025). Call `unhcr_get_asylum_decisions` with origin AFG, the 27 member codes in asylum, and the window. Check each country's levels and units in the staged table with `string_agg(DISTINCT decision_levels, ' | ')` and `string_agg(DISTINCT unit, ',')` grouped by `asylum_iso3`. Then compute the rates from the sums:

```sql
SELECT year,
       ROUND(100 * CAST(SUM(recognized) AS DOUBLE) / SUM(substantive_decisions), 1) AS refugee_recognition_rate,
       ROUND(100 * CAST(SUM(recognized + complementary_protection) AS DOUBLE) / SUM(substantive_decisions), 1) AS total_protection_rate
FROM df_XXXXX_XXXXX
WHERE unit = 'persons' AND substantive_decisions IS NOT NULL
GROUP BY year ORDER BY year
```

The WHERE clause filters numerator and denominator alike. Averaging the per-country rate columns instead puts the 2020 EU Total Protection Rate at 42.5% rather than 59.6%.

**Children's share of a host's refugees.** Call `unhcr_get_demographics` with the asylum country, `population_types` `["REF"]`, and the year. Add `female_0_4`, `female_5_11`, `female_12_17`, and their `male_` twins, divide by `female_total + male_total` minus the two `*_unknown_age` bands, and report `sex_disaggregated_share` beside the result.
