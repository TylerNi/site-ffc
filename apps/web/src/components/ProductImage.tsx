import { productImageUrl } from '@/lib/images';

interface ProductImageProps {
  image?: {
    url: string;
    alt?: string | null;
    width?: number | null;
    height?: number | null;
  } | null;
  /** Nom du produit — texte de repli et accessibilité du placeholder. */
  name: string;
  /** Taille nominale affichée dans le placeholder (ex. « 16x25x1 »). */
  sizeLabel?: string;
  /** Libellé accessible du placeholder (localisé par l'appelant). */
  placeholderAlt: string;
  /** Image au-dessus de la ligne de flottaison (LCP) : pas de lazy loading. */
  priority?: boolean;
}

/**
 * Image produit, ou placeholder SVG dimensionné tant que le CDN d'images
 * n'est pas branché (tâche 08). Dimensions toujours explicites — zéro CLS.
 */
export function ProductImage({
  image,
  name,
  sizeLabel,
  placeholderAlt,
  priority,
}: ProductImageProps) {
  const url = productImageUrl(image);

  if (url) {
    return (
      <img
        src={url}
        alt={image?.alt ?? name}
        width={image?.width ?? 800}
        height={image?.height ?? 600}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
      />
    );
  }

  // Filtre à plis stylisé : cadre + plissage en accordéon + taille nominale.
  return (
    <svg
      viewBox="0 0 400 300"
      role="img"
      aria-label={placeholderAlt}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="400" height="300" fill="var(--brand-soft)" />
      <rect
        x="70"
        y="45"
        width="260"
        height="180"
        rx="10"
        fill="#fff"
        stroke="var(--brand)"
        strokeWidth="3"
      />
      <path
        d="M85 60 l23 150 l23 -150 l23 150 l23 -150 l23 150 l23 -150 l23 150 l23 -150 l23 150 l23 -150"
        fill="none"
        stroke="var(--brand)"
        strokeWidth="2"
        opacity="0.45"
      />
      {sizeLabel ? (
        <text
          x="200"
          y="268"
          textAnchor="middle"
          fontFamily="inherit"
          fontSize="26"
          fontWeight="700"
          fill="var(--brand-dark)"
        >
          {sizeLabel}
        </text>
      ) : null}
    </svg>
  );
}
