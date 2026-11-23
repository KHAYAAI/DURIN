import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'node:path';

/**
 * Integration tests boot the real Nest application against a real PostgreSQL database.
 * SWC is required: Nest's dependency injection needs emitDecoratorMetadata, which esbuild lacks.
 */
export default defineConfig({
  plugins: [swc.vite()],
  resolve: {
    alias: {
      '@durin/ledger': resolve(__dirname, '../packages/ledger/src/index.ts'),
      '@durin/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.int.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    // One shared database: run files one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
