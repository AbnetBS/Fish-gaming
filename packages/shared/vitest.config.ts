import { defineConfig } from 'vitest/config';

/** Shared-package tests run against the TypeScript sources directly. */
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
