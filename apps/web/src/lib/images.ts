/**
 * Résolution des images produit. L'API renvoie des clés S3 relatives
 * (« products/…/principale.jpg ») : elles ne deviennent des URL qu'avec un
 * CDN configuré (`NEXT_PUBLIC_ASSETS_BASE_URL`, brancher à la tâche 08).
 * Sans CDN, les composants affichent un placeholder SVG dimensionné —
 * zéro requête cassée, zéro CLS.
 */
export function productImageUrl(image: { url: string } | null | undefined): string | null {
  if (!image?.url) return null;
  if (/^https?:\/\//i.test(image.url)) return image.url;
  const base = process.env.NEXT_PUBLIC_ASSETS_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${image.url.replace(/^\/+/, '')}`;
}
