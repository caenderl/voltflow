import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The workspace package points at TS source; resolve it directly so
      // vitest transforms it instead of treating it as an external dep.
      '@org/shared-types': fileURLToPath(
        new URL('./libs/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/**/src/**/*.spec.ts', 'libs/**/src/**/*.spec.ts'],
  },
});
