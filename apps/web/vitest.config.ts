import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Tests unitaires des fonctions pures (SEO, JSON-LD, sitemap, formats). */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    server: {
      deps: {
        // next-intl (ESM) importe « next/navigation » sans extension —
        // laisser vite le transformer plutôt que Node.
        inline: ['next-intl', 'use-intl'],
      },
    },
  },
});
