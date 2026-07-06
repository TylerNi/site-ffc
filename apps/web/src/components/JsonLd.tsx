import { serializeJsonLd } from '@/lib/jsonld';

/** Injecte un bloc de données structurées schema.org dans le HTML rendu. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Sérialisation contrôlée (échappement de `<`) — pas d'entrée utilisateur brute.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
