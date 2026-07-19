import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Les images produit passent par <img> + placeholder SVG tant que le CDN
  // d'images n'est pas branché (tâche 08) — voir src/lib/images.ts.

  // Le 308 automatique de Next sur les barres obliques finales passerait
  // AVANT le middleware : une vieille URL BigCommerce (`/m8-1056/`) ferait
  // 308 puis 301 — une chaîne, interdite (tâche 25). Le middleware refait
  // cette normalisation lui-même, APRÈS la table de redirections.
  skipTrailingSlashRedirect: true,
};

export default withNextIntl(nextConfig);
