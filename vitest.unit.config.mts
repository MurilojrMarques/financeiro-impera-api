import { defineConfig } from 'vitest/config';

// Somente unitários: rápidos, sem banco.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
