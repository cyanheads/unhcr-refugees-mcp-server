<div align="center">
  <h1>@cyanheads/unhcr-refugees-mcp-server</h1>
  <p><b>Query UNHCR refugee, IDP, and stateless populations, asylum decisions, returns, and resettlement via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools (+1 opt-in)</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/unhcr-refugees-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/unhcr-refugees-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/unhcr-refugees-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/unhcr-refugees-mcp-server/releases/latest/download/unhcr-refugees-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=unhcr-refugees-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW5oY3ItcmVmdWdlZXMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22unhcr-refugees-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Funhcr-refugees-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Displacement statistics from the keyless [UNHCR Refugee Data Finder API](https://api.unhcr.org/docs/refugee-statistics.html): refugee, asylum-seeker, IDP, and stateless populations by country of origin and asylum from 1951, asylum applications and decisions from 2000, and returns, resettlement, and naturalisation from 1959. Resolve country names to ISO3 codes, pull annual figures with notes on how to read them, and run SQL over results too large to return inline. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `unhcr_list_reference` | Decode countries (ISO3, ISO2, and UNHCR codes, names, regions), regional bureaus, dataset coverage years, population types, and asylum codes |
| `unhcr_get_population` | Year-end displacement stocks by origin and/or asylum country from 1951, with UNRWA and IDMC series alongside and an optional current-year nowcast |
| `unhcr_get_demographics` | Year-end stocks by population type, sex, and age band from 2001, with the share UNHCR could disaggregate |
| `unhcr_get_asylum_applications` | Asylum applications lodged per year from 2000, split by application stage by default |
| `unhcr_get_asylum_decisions` | Asylum decisions per year from 2000 by outcome, with the Refugee Recognition Rate and Total Protection Rate |
| `unhcr_get_solutions` | Refugee returns, resettlement, naturalisation, and IDP returns per year from 1959 |
| `unhcr_dataframe_describe` | Describe a staged dataframe by name, or list them all where listing is on, with provenance, expiry, completeness, and column schema |
| `unhcr_dataframe_query` | Run one read-only SQL `SELECT` across staged dataframes, optionally saving the result as a new one |
| `unhcr_dataframe_drop` | Drop a staged dataframe before its TTL — opt-in, absent from `tools/list` by default |

`unhcr_dataframe_drop` is registered only when `UNHCR_DATAFRAME_DROP_ENABLED=true`; the other eight tools are always advertised.

### Dataframe workflow

1. A `unhcr_get_*` call whose full result exceeds `limit`, or that sets `stage: true`, stages every row as a `df_XXXXX_XXXXX` table and returns its handle in `dataset`.
2. `unhcr_dataframe_describe` lists the staged tables with their columns, source call, and expiry. Listing is off over HTTP with `MCP_AUTH_MODE=none`, so there describe each table by the name in `dataset`.
3. `unhcr_dataframe_query` runs one read-only DuckDB `SELECT` across them; `register_as` saves the result as a new table for the next query.
4. Tables expire after `UNHCR_DATASET_TTL_SECONDS` (24 hours by default). With `UNHCR_DATAFRAME_DROP_ENABLED=true`, `unhcr_dataframe_drop` removes one sooner. Once a tenant's staged rows pass 1,000,000, the oldest tables are evicted first, and the call that pushed the total over names them in `evicted`.

Dataframes run on DuckDB's native binding, which the npm and Docker installs carry. The Claude Desktop `.mcpb` bundle ships without it, so there the data tools answer inline only. Set `CANVAS_PROVIDER_TYPE=none` to turn dataframes off anywhere.

## Capability reference

The five `unhcr_get_*` tools share one contract:

- **Scope:** `origin` and `asylum` take ISO3 codes, case-insensitive, as a string or a list, up to 50 each. ISO2 codes are rewritten to ISO3; UNHCR's own codes and country names are rejected. Each listed code returns its own rows, and an omitted dimension is summed into one row unless `expand` (`origin`, `asylum`, or `both`) lists every country. `year_from` / `year_to` default to the dataset's span and are clamped to it.
- **Rows:** the full result is sorted by `sort_by`, then cut to `limit` (1–500, default 100). Where dataframes are on, the full set of a larger result is staged, and `stage: true` stages a result that fits too.
- **Output:** `total_rows`, `complete` (false when `UNHCR_MAX_ROWS` stopped the fetch), `measure` (`stock` or `flow`), `applied_scope`, `latest_year`, `dataset` when staged, `data_notes`, and `attribution`.
- **Errors:** `unknown_country_code`, `invalid_year_window`, `year_out_of_coverage`, `conflicting_scope`, and the retryable `upstream_busy`, which carries `retryAfter`.

---

### `unhcr_list_reference` <sub>tool</sub>

- `topic`: `countries`, `regions`, `coverage`, `population_types`, or `asylum_codes`. With `countries`, `name_contains` keeps countries whose names contain every word given, or whose ISO3, ISO2, or UNHCR code equals one; there is no fuzzy matching
- `coverage` gives each dataset's `first_year`, `latest_year`, and `measure`, plus the month of the current `nowcast`
- Countries, regions, and coverage come from the live API and are cached for 24 hours; population types and asylum codes are static, and asylum codes UNHCR's methodology does not define carry `documented: false`

---

### `unhcr_get_population` <sub>tool</sub>

- Year-end stocks `refugees`, `asylum_seekers`, `oip`, `idps`, `stateless`, `ooc`, and `hst`, plus `returned_refugees` and `returned_idps`, which are flows during the year; `sort_by` takes any of them or `year`
- `unrwa_refugees` (Palestine refugees registered with UNRWA) and `idmc_conflict_idps` (IDMC's conflict-IDP estimate) sit beside a row when that series has one and are never added into UNHCR's counts. Matching UNHCR `footnotes` come back too, up to 20, with `footnotes_total`
- `include_nowcast: true` appends UNHCR's current-year monthly estimate of refugees and asylum-seekers by asylum country; it is skipped when `origin` lists codes

---

### `unhcr_get_demographics` <sub>tool</sub>

- `population_types` filters to `REF`, `ASY`, `OIP`, `IDP`, `STA`, `OOC`, `HST`, `RET`, or `RDP`; `sort_by` takes `year` or `total`
- Each row is one population type: `total`, fourteen sex × age bands (`female_0_4` … `female_60_plus`, `female_unknown_age`, `female_total`, and the `male_*` twins), `disaggregated`, and `sex_disaggregated_share` (0–1). Bands are null where UNHCR has no breakdown
- Totals come from a separate collection and need not match `unhcr_get_population`; matching `footnotes` come back as there

---

### `unhcr_get_asylum_applications` <sub>tool</sub>

- `split_by` names which of `authority`, `stage`, and `decision_level` stay separate rows (default `["stage"]`; `[]` gives one total per year, scope, and unit). `stages` filters before summing, e.g. `["N"]` for new applications; `sort_by` takes `year` or `applied`
- Each row lists the `authorities`, `stages`, and `decision_levels` codes summed into it, its `unit` (`persons` or `cases`), and `applied`. Cases are never added to persons

---

### `unhcr_get_asylum_decisions` <sub>tool</sub>

- `split_by` names which of `authority` and `decision_level` stay separate rows (default `[]`, all summed, as UNHCR does for its rates). `decision_levels` filters before summing, e.g. `["FI"]` for first instance
- Each row carries `recognized`, `complementary_protection`, `rejected`, `otherwise_closed`, `total_decisions`, `substantive_decisions`, and a `unit`, plus `refugee_recognition_rate` and `total_protection_rate` as percentages of substantive decisions. A rate is null when that denominator is 0 or null
- `sort_by` takes `year` or a count (`total_decisions`, `substantive_decisions`, `recognized`, `rejected`); rates are not sortable

---

### `unhcr_get_solutions` <sub>tool</sub>

- Flows `returned_refugees`, `resettlement`, `naturalisation`, and `returned_idps`; `sort_by` takes any of them or `year`. Matching `footnotes` come back as with population
- The asylum country means something different per column: the country refugees returned from, the country they were resettled to, the country that naturalised them. IDP returns sit on the origin country itself

---

### `unhcr_dataframe_describe` <sub>tool</sub>

- Optional `name` (`df_XXXXX_XXXXX`); omit it to list every staged table, newest first. Over HTTP with `MCP_AUTH_MODE=none` listing is off and `name` is required
- Each entry gives `source_tool`, `query_params`, `created_at`, `expires_at`, `row_count`, `complete`, `providers`, and `column_schema`. Staged tables add `origin_unhcr_region`, `origin_unsd_region`, `asylum_unhcr_region`, and `asylum_unsd_region` columns the inline rows omit

---

### `unhcr_dataframe_query` <sub>tool</sub>

- `sql` is one DuckDB `SELECT` of at most 20,000 characters; joins, aggregates, window functions, and CTEs work. Writes, DDL, `PRAGMA`, `ATTACH`, file-reading functions, and system catalogs are rejected with a typed reason
- `row_limit` (1–10,000, default 1,000) caps the rows the query materializes, and `row_count_capped` flags a capped result. `preview` returns fewer rows inline; `register_as` saves the result under a new `df_XXXXX_XXXXX` name with a fresh TTL. It counts toward the 1,000,000-row staging budget, and a result that alone exceeds it fails `register_as_too_large`
- `SUM` and `COUNT` values come back as strings (BIGINT). `attribution` credits the third-party series of every table the SQL reads

---

### `unhcr_dataframe_drop` <sub>tool</sub>

- `name` (`df_XXXXX_XXXXX`); returns `dropped: false` when nothing matched, so repeating a call is safe
- Registered only when `UNHCR_DATAFRAME_DROP_ENABLED=true`; otherwise the per-table TTL reclaims staged tables

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

UNHCR-specific:

- Keyless client for the API behind UNHCR's Refugee Data Finder (`api.unhcr.org/population/v1`). The API ignores unknown parameters and lone year bounds rather than rejecting them, so the server sends only allowlisted parameters, always pairs the year bounds, and pins ISO3 country matching (`cf_type=ISO`)
- Shared request queue: paced request starts (`UNHCR_REQUESTS_PER_SECOND`), at most two in flight, a cooldown after a 429, identical requests collapsed into one, a response cache, and a 45-second budget per call
- UNHCR's reading of the numbers: stocks and flows labelled as such, UNHCR's `"-"` returned as null rather than zero, cases never added to persons, recognition rates over UNHCR's substantive-decision denominator
- UNHCR rounds counts below 5 (below 10 for asylum decisions) to the nearest multiple of 5, so small values are approximate
- Every result carrying UNHCR figures cites the "UNHCR Refugee Population Statistics Database" (CC BY 4.0) with a link to UNHCR's [Terms of Use for Datasets](https://www.unhcr.org/what-we-do/data-and-publications/data-and-statistics/terms-use-datasets). UNRWA and IDMC figures are those providers' own series, carried through UNHCR's API; `attribution.providers` credits them whenever they appear, since their own conditions may apply

Agent-friendly output:

- Provenance on every data result: `applied_scope` echoes the codes, year window, and ISO2 rewrites actually sent, alongside `latest_year`, `measure`, `complete`, and `attribution`
- Caveats as data: `data_notes` say how to read each result (stock or flow, rounding, what null means), and matching UNHCR `footnotes` arrive with `rows_matched`
- Typed failures with recovery hints: `unknown_country_code` suggests the ISO3 for a UNHCR code, `year_out_of_coverage` names the dataset's span, `upstream_busy` carries `retryAfter`
- Nothing trimmed silently: year clamps, empty-result hints, truncation, and where the full set was staged all arrive as a notice in the response

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "unhcr-refugees-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/unhcr-refugees-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "unhcr-refugees-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/unhcr-refugees-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "unhcr-refugees-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/unhcr-refugees-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: UNHCR's API is keyless, and every variable below is optional.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/unhcr-refugees-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd unhcr-refugees-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optional: every variable has a working default
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `UNHCR_REQUESTS_PER_SECOND` | Upstream request starts per second for the whole process (1–10). Every caller of an HTTP instance shares it. | `4` |
| `UNHCR_MAX_ROWS` | Most upstream rows one tool call fetches (10,000–500,000). A larger result stops at the cap and reports `complete: false`. | `150000` |
| `UNHCR_CACHE_MAX_MB` | Response-cache budget in MB; `0` disables it. Reference data (countries, regions, coverage, footnotes) has its own cache, always on. | `64` |
| `UNHCR_DATASET_TTL_SECONDS` | Lifetime of a staged dataframe, in seconds (minimum 60). | `86400` |
| `UNHCR_DATAFRAME_DROP_ENABLED` | Set `true` to register `unhcr_dataframe_drop`. | `false` |
| `CANVAS_PROVIDER_TYPE` | Dataframe engine: `duckdb`, or `none` to turn dataframes off. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck   # Lints, formats, type-checks, and more
  bun run test       # Runs the test suite
  bun run test:live  # Opt-in: re-checks the upstream behaviors the client relies on against api.unhcr.org
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: server instructions, tool registration, service setup. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`) and the registration list that gates `unhcr_dataframe_drop`. |
| `src/mcp-server/tools/shared` | Scope inputs, output schemas, result shaping, and markdown rendering shared by the data tools. |
| `src/services/unhcr` | UNHCR API client — request builder, paced fetch, response cache, reference data, normalization, asylum aggregation, footnote matching. |
| `src/services/canvas-bridge` | Adapter to the framework DataCanvas — dataframe naming, provenance, expiry, and the read-only SQL gate. |
| `tests/` | Unit tests mirroring the `src/` structure, plus the opt-in live suite in `tests/live/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `buildToolDefinitions()` in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

The data belongs to UNHCR and is published under CC BY 4.0 and UNHCR's [Terms of Use for Datasets](https://www.unhcr.org/what-we-do/data-and-publications/data-and-statistics/terms-use-datasets). This project is independent of UNHCR and not endorsed by it.
