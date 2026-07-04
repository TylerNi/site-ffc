import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild (le transformateur par défaut de vitest) n'émet pas les
  // métadonnées de décorateurs (design:paramtypes) dont NestJS a besoin
  // pour l'injection de dépendances : les tests e2e passent par SWC.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
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
