import { defineConfig } from 'vitest/config';

// A deterministic, Node-native test environment keeps policy tests portable.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/dist/**', '**/*.test.ts', '**/*.spec.ts'],
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
