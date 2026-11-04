/**
 * @fileoverview The bundle cleaner and the packaging linter select the same
 * dependency agent docs: `framework-skills/`, `skills/`, `.claude/`, and
 * `.agents/` trees at an installed package's root, and every `SKILL.md`. A
 * `skills/` directory deeper in a package is runtime code the bundle must keep
 * — the MCP SDK loads its `dist/ext/skills/` modules at startup.
 * @module tests/scripts/mcpb-agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import {
  checkBundleEntries,
  AGENT_DOC_ENTRY as LINTER_AGENT_DOC_ENTRY,
} from '../../scripts/lint-packaging.js';

const keptEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'node_modules/@scope/skills/index.js',
  'skills/unhcr-guide/SKILL.md',
  'dist/index.js',
];

const agentDocEntries = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/example/skills/guide/guide.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/notes.md',
  'node_modules/@scope/skills/skills/guide/reference.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/guide.md',
  'node_modules/example/SKILL.md',
  'node_modules/example/docs/SKILL.md',
];

describe('dependency agent-doc entries in a bundle', () => {
  it('strips package-root agent trees and every SKILL.md, keeping runtime skills/ modules', () => {
    expect(filterAgentDocEntries([...keptEntries, ...agentDocEntries])).toEqual(agentDocEntries);
  });

  it('passes a bundle that keeps the runtime modules through the packaging check', () => {
    expect(checkBundleEntries(keptEntries, 'dist/x.mcpb')).toEqual([]);
  });

  it('fails a bundle that still holds agent docs, counting only those', () => {
    const errors = checkBundleEntries([...keptEntries, ...agentDocEntries], 'dist/x.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dist/x.mcpb contains 9 node_modules agent-doc entries');
  });

  it('uses one selector in the cleaner and the linter', () => {
    expect(LINTER_AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(LINTER_AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });
});
