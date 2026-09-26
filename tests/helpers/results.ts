/**
 * @fileoverview Readers for the two surfaces a tool result reaches clients
 * through: `structuredContent` (including the error envelope) and the
 * `content[]` text blocks.
 * @module tests/helpers/results
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';

/** A `CallToolResult` as `runToolContract` returns it. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** The error envelope on `structuredContent.error`. */
export interface ToolErrorEnvelope {
  code: number;
  data?: Record<string, unknown> & { reason?: string; recovery?: { hint?: string } };
  message: string;
}

/** Join the text blocks of a `content[]` array (or a `format()` result). */
export function textOf(blocks: ToolResult['content'] | readonly { type: string }[]): string {
  return blocks
    .flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

/** The structured success payload, asserting the call did not fail. */
export function structuredOf(result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new Error(`Expected success, got: ${textOf(result.content)}`);
  return result.structuredContent as Record<string, unknown>;
}

/** The structured error envelope, asserting the call failed. */
export function errorOf(result: ToolResult): ToolErrorEnvelope {
  if (!result.isError) throw new Error('Expected an error result');
  return (result.structuredContent as { error: ToolErrorEnvelope }).error;
}
