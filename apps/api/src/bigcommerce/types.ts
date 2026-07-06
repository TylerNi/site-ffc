/**
 * Types du sous-ensemble de l'API BigCommerce (v3 catalogue + v3 content)
 * effectivement consommé par l'import (tâche 08). Pas exhaustif — seulement
 * les champs lus par `export.ts`/`transform.ts`.
 */

/** Les deux vitrines BigCommerce sources. */
export type StoreKey = 'en' | 'fr';

export const STORE_KEYS: readonly StoreKey[] = ['en', 'fr'];

export interface BigCommerceCustomField {
  id: number;
  name: string;
  value: string;
}

export interface BigCommerceImage {
  id: number;
  product_id: number;
  url_standard: string;
  url_zoom: string;
  is_thumbnail: boolean;
  sort_order: number;
  /** BigCommerce stocke le texte alternatif dans `description`. */
  description: string;
}

export interface BigCommerceVariantOptionValue {
  option_display_name: string;
  label: string;
}

export interface BigCommerceVariant {
  id: number;
  product_id: number;
  sku: string;
  upc: string | null;
  price: number | null;
  weight: number | null;
  option_values: BigCommerceVariantOptionValue[];
}

export interface BigCommerceProduct {
  id: number;
  name: string;
  sku: string;
  price: number;
  cost_price: number;
  retail_price: number | null;
  weight: number;
  brand_id: number | null;
  categories: number[];
  is_visible: boolean;
  is_featured: boolean;
  custom_url: { url: string; is_customized: boolean };
  page_title: string;
  meta_description: string;
  description: string;
  custom_fields: BigCommerceCustomField[];
  images: BigCommerceImage[];
  variants: BigCommerceVariant[];
}

export interface BigCommerceCategory {
  id: number;
  parent_id: number;
  name: string;
  description: string;
  sort_order: number;
  is_visible: boolean;
  custom_url: { url: string; is_customized: boolean };
}

export interface BigCommerceBrand {
  id: number;
  name: string;
  page_title: string;
  meta_description: string;
  image_url: string;
  custom_url: { url: string; is_customized: boolean };
}

export interface BigCommercePage {
  id: number;
  name: string;
  type: string;
  is_visible: boolean;
  url: string;
}

/** Catalogue brut d'UNE vitrine, tel qu'extrait par `export.ts`. */
export interface StoreCatalog {
  store: StoreKey;
  domain: string;
  fetchedAt: string;
  brands: BigCommerceBrand[];
  categories: BigCommerceCategory[];
  products: BigCommerceProduct[];
  pages: BigCommercePage[];
}

/** Export complet des deux vitrines — persisté tel quel dans `data/raw/`. */
export interface CatalogExport {
  fetchedAt: string;
  stores: Record<StoreKey, StoreCatalog>;
}
