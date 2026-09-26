/**
 * @fileoverview Server-specific configuration for the UNHCR Refugee Statistics
 * API client and the staged-dataframe canvas. Parsed lazily so a Worker-style
 * late env injection still sees every variable.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  requestsPerSecond: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(4)
    .describe(
      'Upstream request starts per second for the whole process. Every caller of a hosted instance shares it.',
    ),
  maxRows: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(500_000)
    .default(150_000)
    .describe(
      'Most upstream rows one tool call fetches. A larger result stops at the cap and reports complete: false.',
    ),
  cacheMaxMb: z.coerce
    .number()
    .int()
    .min(0)
    .default(64)
    .describe(
      'Response-cache budget in MB; 0 disables it. Reference data (countries, regions, coverage, footnotes) is cached separately and always on.',
    ),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .default(86_400)
    .describe('Per-table TTL for staged dataframes, in seconds.'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Registers unhcr_dataframe_drop live instead of disabled. Off by default; the per-table TTL reclaims staged tables on its own.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parse (once) and return the server's own env-driven configuration. */
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
