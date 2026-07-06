import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Les images produit passent par <img> + placeholder SVG tant que le CDN
  // d'images n'est pas branché (tâche 08) — voir src/lib/images.ts.
};

export default withNextIntl(nextConfig);
