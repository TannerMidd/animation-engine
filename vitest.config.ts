import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // Keep generated reports below an already-ignored directory. A root
      // `coverage/` directory is importable as a Python namespace package and
      // shadows the real coverage package while Numba imports Chatterbox.
      reportsDirectory: '.cache/coverage',
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
