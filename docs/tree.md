# unhcr-refugees-mcp-server - Directory Structure

Generated on: 2026-09-26 22:21:54

```text
unhcr-refugees-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── dataframe-describe.tool.ts
│   │       │   ├── dataframe-drop.tool.ts
│   │       │   ├── dataframe-query.tool.ts
│   │       │   ├── get-asylum-applications.tool.ts
│   │       │   ├── get-asylum-decisions.tool.ts
│   │       │   ├── get-demographics.tool.ts
│   │       │   ├── get-population.tool.ts
│   │       │   ├── get-solutions.tool.ts
│   │       │   ├── index.ts
│   │       │   └── list-reference.tool.ts
│   │       └── shared/
│   │           ├── inputs.ts
│   │           ├── markdown.ts
│   │           ├── outputs.ts
│   │           ├── results.ts
│   │           └── scope.ts
│   ├── services/
│   │   ├── canvas-bridge/
│   │   │   └── canvas-bridge.ts
│   │   └── unhcr/
│   │       ├── asylum-aggregate.ts
│   │       ├── codes.ts
│   │       ├── country-input.ts
│   │       ├── footnote-match.ts
│   │       ├── normalize.ts
│   │       ├── response-cache.ts
│   │       ├── types.ts
│   │       └── unhcr-api-service.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   └── unhcr.ts
│   ├── helpers/
│   │   ├── dataframes.ts
│   │   ├── fake-unhcr.ts
│   │   ├── results.ts
│   │   └── services.ts
│   ├── live/
│   │   └── upstream-behavior.test.ts
│   ├── services/
│   │   ├── canvas-bridge/
│   │   │   └── canvas-bridge.test.ts
│   │   └── unhcr/
│   │       ├── asylum-aggregate.test.ts
│   │       ├── codes.test.ts
│   │       ├── country-input.test.ts
│   │       ├── footnote-match.test.ts
│   │       ├── normalize.test.ts
│   │       ├── response-cache.test.ts
│   │       └── unhcr-api-service.test.ts
│   ├── tools/
│   │   ├── dataframe-describe.tool.test.ts
│   │   ├── dataframe-drop.tool.test.ts
│   │   ├── dataframe-query.tool.test.ts
│   │   ├── definitions.test.ts
│   │   ├── get-asylum-applications.tool.test.ts
│   │   ├── get-asylum-decisions.tool.test.ts
│   │   ├── get-demographics.tool.test.ts
│   │   ├── get-population.tool.test.ts
│   │   ├── get-solutions.tool.test.ts
│   │   ├── list-reference.tool.test.ts
│   │   ├── shared.test.ts
│   │   └── yearless-rows.test.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
├── vitest.config.ts
└── vitest.live.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
