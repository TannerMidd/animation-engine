import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/server/**'],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 73,
      },
    },
  },
});
