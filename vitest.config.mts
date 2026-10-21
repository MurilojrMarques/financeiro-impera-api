import { defineConfig } from 'vitest/config';

// Suíte completa: unitários + integração/e2e com PostgreSQL real (globalSetup).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false, // arquivos de integração compartilham o mesmo banco
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
