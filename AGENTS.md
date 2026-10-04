# Developer Protocol

**Server:** unhcr-refugees-mcp-server
**Version:** 0.1.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.11`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.2.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Data tool

Every `unhcr_get_*` tool has the same shape, shown here condensed from `unhcr_get_solutions`: the shared `scopeInputs` / `resultInputs`, `resolveScope()` to validate codes, `expand`, and the year window before any data fetch, and `finishRows()` to sort, cut to `limit`, stage the overflow as a `df_<id>` dataframe, and write the one enrichment notice.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { matchFootnotes, typesWithCounts } from '@/services/unhcr/footnote-match.js';
import { SOLUTIONS_FIELDS } from '@/services/unhcr/types.js';
import { getUnhcrService } from '@/services/unhcr/unhcr-api-service.js';
import { blankAsUnset, resultInputs, scopeInputs } from '../shared/inputs.js';
import { countField, dataEnrichment, identityFields, sharedResultFields } from '../shared/outputs.js';
import { finishRows } from '../shared/results.js';
import { resolveScope } from '../shared/scope.js';

export const getSolutionsTool = tool('unhcr_get_solutions', {
  title: 'UNHCR durable solutions',
  description: 'Get durable solutions per year (1959 to the latest year) by country of origin and/or asylum: …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...scopeInputs, // origin, asylum, expand, year_from, year_to
    sort_by: blankAsUnset(z.enum(['year', 'returned_refugees', /* … */]).default('year')).describe('…'),
    ...resultInputs, // limit, stage
  }),

  output: z.object({
    rows: z.array(z.object({
      ...identityFields,
      returned_refugees: countField('Refugees who returned to their origin country during the year, …'),
      // resettlement, naturalisation, returned_idps
    }).describe('…')).describe('Inline rows, sorted, up to limit.'),
    ...sharedResultFields, // total_rows, complete, measure, applied_scope, latest_year, dataset?, data_notes, attribution
    // footnotes, footnotes_total
  }),

  enrichment: dataEnrichment,

  errors: [
    {
      reason: 'unknown_country_code',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: "An origin or asylum value is not an ISO3 code in UNHCR's country list (after ISO2 normalization)",
      recovery: 'Find the country with unhcr_list_reference (topic countries, name_contains) and pass its ISO3 code.',
    },
    // invalid_year_window, year_out_of_coverage, conflicting_scope, upstream_busy (thrownBy: 'service')
  ],

  async handler(input, ctx) {
    const resolved = await resolveScope(input, 'solutions', ctx);
    if (!resolved.ok) {
      const { failure } = resolved;
      throw ctx.fail(failure.reason, failure.message, {
        ...failure.data,
        ...(failure.hint && { recovery: { hint: failure.hint } }),
      });
    }

    const { scope } = resolved;
    const service = getUnhcrService();
    const [solutions, footnotes] = await Promise.all([
      service.solutions(scope.query, ctx),
      service.footnotes(ctx),
    ]);
    const matched = matchFootnotes(footnotes, solutions.rows, typesWithCounts);
    const finished = await finishRows(ctx, {
      sourceTool: 'unhcr_get_solutions',
      datasetLabel: 'solutions',
      queryParams: { ...input },
      scope,
      rows: solutions.rows,
      fetchedRows: solutions.rows.length + solutions.skippedRows,
      complete: solutions.complete,
      sortBy: input.sort_by,
      limit: input.limit,
      stage: input.stage,
      countFields: SOLUTIONS_FIELDS,
      providers: [],
      notices: [],
      yearlessRows: solutions.skippedRows,
    });

    return {
      ...finished,
      measure: 'flow' as const,
      data_notes: dataNotes({ unexpectedValues: solutions.unexpectedValues, yearlessRows: solutions.skippedRows }),
      footnotes: matched.footnotes,
      footnotes_total: matched.total,
    };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  // renderResultHeader → rows table → renderFootnotes → renderNotesAndAttribution
  format: (result) => [{ type: 'text', text: /* … */ '' }],
});
```

Every result carrying UNHCR figures returns `attribution` (the data tools and `unhcr_dataframe_query`), with third-party series (UNRWA, IDMC) credited in `providers`. Upstream free text — country names, footnotes, nowcast source labels — is data: render it through the `shared/markdown.ts` helpers (`cell`, `inline`, `blockquote`), never raw.

### Resources and prompts

None. Every dataset takes query parameters, and `unhcr_list_reference` serves the reference vocabulary. The `add-resource` and `add-prompt` skills carry the patterns if that changes.

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  requestsPerSecond: z.coerce.number().int().min(1).max(10).default(4).describe('…'),
  maxRows: z.coerce.number().int().min(10_000).max(500_000).default(150_000).describe('…'),
  cacheMaxMb: z.coerce.number().int().min(0).default(64).describe('…'),
  datasetTtlSeconds: z.coerce.number().int().min(60).default(86_400).describe('…'),
  dataframeDropEnabled: z.stringbool().default(false).describe('…'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    requestsPerSecond: 'UNHCR_REQUESTS_PER_SECOND',
    maxRows: 'UNHCR_MAX_ROWS',
    cacheMaxMb: 'UNHCR_CACHE_MAX_MB',
    datasetTtlSeconds: 'UNHCR_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'UNHCR_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
```

Every variable is optional: the upstream is keyless. `src/index.ts` loads `.env` and sets `process.env.CANVAS_PROVIDER_TYPE ??= 'duckdb'` before `createApp()`, so dataframes are on unless an operator sets `none`. A new variable goes into `.env.example`, `server.json`, `manifest.json` (`mcp_config.env` + `user_config`), `.claude-plugin/plugin.json` (`userConfig` + `env`), `.codex-plugin/mcp.json` (`env_vars`), and the README configuration table.

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`UNHCR_MAX_ROWS`) not the path (`maxRows`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
const config = getServerConfig();

await createApp({
  name: 'unhcr-refugees-mcp-server',
  title: 'unhcr-refugees-mcp-server', // must match the unscoped package name — enforced by lint:packaging
  tools: buildToolDefinitions({ dropEnabled: config.dataframeDropEnabled }),
  resources: [],
  prompts: [],
  instructions, // stocks vs flows, ISO3 origin/asylum, dataframes, null and rounding, attribution
  sessionMode: 'stateless',
  setup(core) {
    initUnhcrService({
      config: {
        requestsPerSecond: config.requestsPerSecond,
        maxRows: config.maxRows,
        cacheMaxBytes: config.cacheMaxMb * 1024 * 1024,
      },
    });
    initCanvasBridge(core.canvas, { ttlMs: config.datasetTtlSeconds * 1000 });
  },
  teardown() {
    disposeUnhcrService();
  },
});
```

`description` is never set here — the framework derives it from `package.json`. `instructions` is server-level orientation, sent on every `initialize` as session-level context: the stock/flow split, the ISO3 origin/asylum model, the dataframe hand-off, what null and rounding mean, and the attribution UNHCR's terms require. It names no latest year, since `latest_year` in each result carries that. Update it when a tool is added, renamed, or changes what it returns.

### Session posture and shutdown

`sessionMode: 'stateless'` declares the HTTP session posture in `src/`, since no tool asks the caller for input mid-call. A deployment's `MCP_SESSION_MODE` still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). A tool that starts collecting input via `ctx.requestInput` needs `{ default: 'stateful', require: 'stateful' }` instead: startup then fails with a `ConfigurationError` rather than serving a mode in which a 2025-era client can never answer the prompt. Stdio is never refused.

`teardown()` disposes the UNHCR request pacer. It runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling).

`buildToolDefinitions()` registers `unhcr_dataframe_drop` live only when `UNHCR_DATAFRAME_DROP_ENABLED=true`; otherwise it wraps the tool with `disabledTool()`, which keeps it out of `tools/list` while the HTTP landing page still shows it with the setting that turns it on.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Here it holds the tenant's canvas id (`canvas-id`) and each staged dataframe's provenance and expiry (`df-meta/<name>`). Only `services/canvas-bridge` reads or writes it. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.signal` | `AbortSignal` for cancellation. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point; loads .env, defaults CANVAS_PROVIDER_TYPE to duckdb
  config/
    server-config.ts                    # UNHCR_* env vars (Zod schema, lazy-parsed)
  services/
    unhcr/
      unhcr-api-service.ts              # API client (init/accessor): request builder, paced fetch, page walk, reference data
      response-cache.ts                 # LRU cache of response bodies (TTL + size budget)
      normalize.ts                      # Row values and identities; "-" becomes null, never zero
      country-input.ts                  # origin/asylum parsing: ISO3 accepted, ISO2 rewritten, UNHCR codes refused
      codes.ts                          # Static vocabulary: population types, asylum codes, datasets, attribution
      asylum-aggregate.ts               # Group-and-sum for the asylum tools; decision rates from summed counts
      footnote-match.ts                 # Footnote parsing and row matching
      types.ts                          # Raw and normalized row types
    canvas-bridge/
      canvas-bridge.ts                  # DataCanvas adapter: one canvas per tenant, df_<id> names, metadata in ctx.state
  mcp-server/
    tools/
      definitions/
        index.ts                        # buildToolDefinitions(); unhcr_dataframe_drop via disabledTool() unless enabled
        get-population.tool.ts          # unhcr_get_population
        get-demographics.tool.ts        # unhcr_get_demographics
        get-asylum-applications.tool.ts # unhcr_get_asylum_applications
        get-asylum-decisions.tool.ts    # unhcr_get_asylum_decisions
        get-solutions.tool.ts           # unhcr_get_solutions
        list-reference.tool.ts          # unhcr_list_reference
        dataframe-describe.tool.ts      # unhcr_dataframe_describe
        dataframe-query.tool.ts         # unhcr_dataframe_query
        dataframe-drop.tool.ts          # unhcr_dataframe_drop (opt-in)
      shared/
        inputs.ts                       # scopeInputs, resultInputs, blankAsUnset
        outputs.ts                      # Shared output fields + markdown renderers (renderResultHeader, …)
        scope.ts                        # resolveScope(): country codes, expand, year window
        results.ts                      # finishRows(): sort, cut to limit, stage overflow, enrichment notice
        markdown.ts                     # cell / inline / blockquote for upstream text
```

No `resources/` or `prompts/` directories: the server registers neither.

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with Istanbul coverage |
| `bun run test:live` | Opt-in live suite (`tests/live/`): three keyless requests to api.unhcr.org re-checking the upstream behaviors the request builder relies on. Never part of `bun run test` |
| `bun run start` | Production mode, transport from `MCP_TRANSPORT_TYPE` |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create or repair the GitHub Release on the `v<version>` tag, titled `v<version>: <tag subject>`, with `dist/*.mcpb` attached (used by `release-and-publish`) |
| `bun run publish-mcp` | Log in to the MCP Registry with the GitHub PAT from the macOS Keychain (`mcp-publisher-github-pat`) and publish `server.json` (used by `release-and-publish`) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] A new data tool spreads `scopeInputs` / `resultInputs`, validates through `resolveScope()`, and ends in `finishRows()` — see *Data tool* above
- [ ] Every result carrying UNHCR figures returns `attribution`, with UNRWA or IDMC series credited in `providers`
- [ ] A new env var lands on every surface: `server-config.ts`, `.env.example`, `server.json`, `manifest.json`, `.claude-plugin/plugin.json`, `.codex-plugin/mcp.json`, and the README configuration table
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
