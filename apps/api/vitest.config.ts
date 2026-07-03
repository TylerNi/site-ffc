import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests d'intégration : tous parlent à la même base ffc_test — pas de
    // parallélisme entre fichiers (le test de concurrence des factures crée
    // lui-même ses transactions parallèles).
    fileParallelism: false,
    globalSetup: './test/global-setup.ts',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
