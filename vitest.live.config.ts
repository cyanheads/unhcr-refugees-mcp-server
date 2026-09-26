/**
 * @fileoverview Vitest config for the opt-in live suite (`tests/live/`), run
 * with `bun run test:live`. It sits apart from `vitest.config.ts` because a
 * bare `vitest run` runs every project that file lists, and this suite makes
 * real keyless requests to api.unhcr.org.
 *
 * @module vitest.live.config
 */

import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      name: 'live',
      include: ['tests/live/**/*.test.ts'],
      maxWorkers: 1,
      testTimeout: 60_000,
    },
  }),
);
