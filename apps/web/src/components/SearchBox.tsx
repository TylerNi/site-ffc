'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Suggestion normalisée (taille ou produit) prête à naviguer. */
interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  href: string;
  group: 'sizes' | 'products';
}

interface SearchBoxProps {
  locale: string;
  /** Chemins localisés calculés côté serveur (aucun contexte i18n client). */
  searchPath: string;
  sizesBasePath: string;
  productsBasePath: string;
  apiUrl: string;
  labels: {
    label: string;
    placeholder: string;
    submit: string;
    sizes: string;
    products: string;
    suggestions: string;
  };
  /** Grande variante (héros de l'accueil). */
  initialQuery?: string;
}

interface SuggestResponse {
  sizes: Array<{ label: string; productCount: number }>;
  products: Array<{ slug: string; name: string }>;
}

/**
 * Recherche avec autocomplétion (tailles + produits). Fonctionne sans
 * JavaScript (formulaire GET natif vers la page de recherche); le script
 * n'ajoute que les suggestions. Clavier : ↑ ↓ Entrée Échap.
 */
export function SearchBox({
  locale,
  searchPath,
  sizesBasePath,
  productsBasePath,
  apiUrl,
  labels,
  initialQuery,
}: SearchBoxProps) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState(initialQuery ?? '');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Fermer au clic hors du composant.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [close]);

  const fetchSuggestions = useCallback(
    (value: string) => {
      abortRef.current?.abort();
      if (value.trim().length < 2) {
        setSuggestions([]);
        close();
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const url = `${apiUrl}/v1/catalog/search/suggest?locale=${locale}&q=${encodeURIComponent(value.trim())}`;
      fetch(url, { signal: controller.signal })
        .then((res) => (res.ok ? (res.json() as Promise<SuggestResponse>) : null))
        .then((data) => {
          if (!data) return;
          const next: Suggestion[] = [
            ...data.sizes.map((size) => ({
              key: `size-${size.label}`,
              label: size.label,
              detail: String(size.productCount),
              href: `${sizesBasePath}/${encodeURIComponent(size.label)}`,
              group: 'sizes' as const,
            })),
            ...data.products.map((product) => ({
              key: `product-${product.slug}`,
              label: product.name,
              href: `${productsBasePath}/${encodeURIComponent(product.slug)}`,
              group: 'products' as const,
            })),
          ];
          setSuggestions(next);
          setOpen(next.length > 0);
          setActive(-1);
        })
        .catch(() => {
          /* réseau/abandon — la recherche native reste disponible */
        });
    },
    [apiUrl, locale, sizesBasePath, productsBasePath, close],
  );

  const onChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 150);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === 'Escape') {
      close();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      const target = suggestions[active];
      if (target) {
        close();
        router.push(target.href);
      }
    }
  };

  const groups: Array<{ group: Suggestion['group']; title: string }> = [
    { group: 'sizes', title: labels.sizes },
    { group: 'products', title: labels.products },
  ];

  return (
    <div className="searchbox" ref={rootRef}>
      <form action={searchPath} method="get" role="search" onSubmit={close}>
        <input
          type="search"
          name="q"
          value={query}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder={labels.placeholder}
          aria-label={labels.label}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          required
        />
        <button type="submit">{labels.submit}</button>
      </form>
      {open ? (
        <div className="suggest" id={listId} role="listbox" aria-label={labels.suggestions}>
          {groups.map(({ group, title }) => {
            const items = suggestions.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <div className="suggest-group">{title}</div>
                {items.map((suggestion) => {
                  const index = suggestions.indexOf(suggestion);
                  return (
                    <button
                      key={suggestion.key}
                      type="button"
                      className="suggest-item"
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => {
                        close();
                        router.push(suggestion.href);
                      }}
                    >
                      <span>{suggestion.label}</span>
                      {suggestion.detail ? (
                        <span className="muted">{suggestion.detail}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
