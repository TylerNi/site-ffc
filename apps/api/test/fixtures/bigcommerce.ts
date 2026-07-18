/**
 * Fixtures BigCommerce partagées par les tests de la tâche 08 — un petit
 * catalogue synthétique couvrant chaque cas du brief : paire fr/en par SKU,
 * produit sans équivalent, paire candidate à revue manuelle (dimensions +
 * marque, sans SKU commun), taille non reconnue, SKU en double entre deux
 * produits non apparentés, catégorie orpheline, produit sans marque/image.
 */
import type {
  BigCommerceBrand,
  BigCommerceCategory,
  BigCommercePage,
  BigCommerceProduct,
  CatalogExport,
} from '../../src/bigcommerce/types';

// Noms/slugs volontairement distincts du seed (tâche 04 : marque « PureFlow »,
// catégorie « furnace-filters »/« filtres-de-fournaise »…) pour que le test
// d'intégration (base ffc_test partagée, déjà seedée) ne percute aucune
// contrainte d'unicité (Brand.slug, CategoryTranslation[locale,slug]).
const enBrands: BigCommerceBrand[] = [
  {
    id: 1,
    name: 'ZoneAir',
    page_title: '',
    meta_description: '',
    image_url: 'https://cdn.bc.com/en/zoneair.png',
    custom_url: { url: '/zoneair/', is_customized: true },
  },
];

const frBrands: BigCommerceBrand[] = [
  {
    id: 11,
    name: 'ZoneAir',
    page_title: '',
    meta_description: '',
    image_url: 'https://cdn.bc.com/fr/zoneair.png',
    custom_url: { url: '/zoneair/', is_customized: true },
  },
];

const enCategories: BigCommerceCategory[] = [
  {
    id: 100,
    parent_id: 0,
    name: 'BC Import Root',
    description: '',
    sort_order: 0,
    is_visible: true,
    custom_url: { url: '/bc-import-root/', is_customized: true },
  },
  {
    id: 101,
    parent_id: 100,
    name: 'BC Import 1 Inch',
    description: '',
    sort_order: 0,
    is_visible: true,
    custom_url: { url: '/bc-import-root/1-inch/', is_customized: true },
  },
  // Orpheline : aucune catégorie FR au même index (FR n'a qu'un seul enfant).
  {
    id: 102,
    parent_id: 100,
    name: 'BC Import 4 Inch',
    description: '',
    sort_order: 1,
    is_visible: true,
    custom_url: { url: '/bc-import-root/4-inch/', is_customized: true },
  },
];

const frCategories: BigCommerceCategory[] = [
  {
    id: 200,
    parent_id: 0,
    name: 'Racine Import BC',
    description: '',
    sort_order: 0,
    is_visible: true,
    custom_url: { url: '/racine-import-bc/', is_customized: true },
  },
  {
    id: 201,
    parent_id: 200,
    name: 'Racine Import BC 1 pouce',
    description: '',
    sort_order: 0,
    is_visible: true,
    custom_url: { url: '/racine-import-bc/1-pouce/', is_customized: true },
  },
];

// --- Produit A : paire fr/en propre (SKU partagé) + une variante à taille
//     non reconnue (« 17x99x1 ») côté EN seulement.
const productA_en: BigCommerceProduct = {
  id: 301,
  name: '16x25x1 MERV 11 Furnace Filter - Box of 6',
  sku: 'FF-16x25x1-M11-6',
  price: 59.99,
  cost_price: 30,
  retail_price: 69.99,
  weight: 6.5,
  brand_id: 1,
  categories: [101],
  is_visible: true,
  is_featured: true,
  custom_url: { url: '/16x25x1-merv-11-furnace-filter/', is_customized: true },
  page_title: '16x25x1 MERV 11 Furnace Filter | Furnace Filters Canada',
  meta_description: 'Buy 16x25x1 MERV 11 furnace filters online.',
  description: '<p>High quality pleated furnace filter.</p>',
  custom_fields: [],
  images: [
    {
      id: 1,
      product_id: 301,
      url_standard: 'https://cdn.bc.com/en/301-1-std.jpg',
      url_zoom: 'https://cdn.bc.com/en/301-1-zoom.jpg',
      is_thumbnail: true,
      sort_order: 0,
      description: '16x25x1 MERV 11 furnace filter',
    },
  ],
  variants: [
    {
      id: 4001,
      product_id: 301,
      sku: 'FF-16x25x1-M11-6',
      upc: '012345678905',
      price: 59.99,
      weight: 6.5,
      option_values: [
        { option_display_name: 'Size', label: '16x25x1' },
        { option_display_name: 'MERV', label: '11' },
        { option_display_name: 'Pack', label: 'Box of 6' },
      ],
    },
    {
      id: 4006,
      product_id: 301,
      sku: 'FF-WEIRD-SIZE-EN',
      upc: null,
      price: 59.99,
      weight: 6.5,
      option_values: [{ option_display_name: 'Size', label: '17x99x1' }],
    },
  ],
};

const productA_fr: BigCommerceProduct = {
  id: 401,
  name: 'Filtre de fournaise 16x25x1 MERV 11 - Boîte de 6',
  sku: 'FF-16x25x1-M11-6',
  price: 59.99,
  cost_price: 30,
  retail_price: 69.99,
  weight: 6.5,
  brand_id: 11,
  categories: [201],
  is_visible: true,
  is_featured: false,
  custom_url: { url: '/filtre-fournaise-16x25x1-merv-11/', is_customized: true },
  page_title: 'Filtre de fournaise 16x25x1 MERV 11 | Filtration Montréal',
  meta_description: 'Achetez des filtres de fournaise 16x25x1 MERV 11 en ligne.',
  description: '<p>Filtre plissé de fournaise haute qualité.</p>',
  custom_fields: [],
  images: [
    {
      id: 2,
      product_id: 401,
      url_standard: 'https://cdn.bc.com/fr/401-1-std.jpg',
      url_zoom: 'https://cdn.bc.com/fr/401-1-zoom.jpg',
      is_thumbnail: true,
      sort_order: 0,
      description: 'Filtre de fournaise 16x25x1 MERV 11',
    },
  ],
  variants: [
    {
      id: 5001,
      product_id: 401,
      sku: 'FF-16x25x1-M11-6',
      upc: '012345678905',
      price: 59.99,
      weight: 6.5,
      option_values: [
        { option_display_name: 'Taille', label: '16x25x1' },
        { option_display_name: 'MERV', label: '11' },
        { option_display_name: 'Format', label: 'Boîte de 6' },
      ],
    },
  ],
};

// --- Produit B : EN seulement, aucune correspondance ni candidat FR.
const productB_en: BigCommerceProduct = {
  id: 302,
  name: '20x25x1 MERV 8 Furnace Filter',
  sku: 'FF-20x25x1-M8-1',
  price: 19.99,
  cost_price: 8,
  retail_price: 24.99,
  weight: 1.2,
  brand_id: null,
  categories: [101],
  is_visible: true,
  is_featured: false,
  custom_url: { url: '/20x25x1-merv-8-furnace-filter/', is_customized: true },
  page_title: '',
  meta_description: '',
  description: '',
  custom_fields: [],
  images: [],
  variants: [
    {
      id: 4002,
      product_id: 302,
      sku: 'FF-20x25x1-M8-1',
      upc: null,
      price: 19.99,
      weight: 1.2,
      option_values: [
        { option_display_name: 'Size', label: '20x25x1' },
        { option_display_name: 'MERV', label: '8' },
      ],
    },
  ],
};

// --- Produit C : pas de SKU commun mais dimensions + marque + nom proches →
//     candidat de revue manuelle. Catégorie EN = orpheline (102, « 4 Inch »).
const productC_en: BigCommerceProduct = {
  id: 303,
  name: '16x25x4 MERV 13 Furnace Filter',
  sku: 'FF-16x25x4-M13-EN',
  price: 39.99,
  cost_price: 18,
  retail_price: 44.99,
  weight: 2.5,
  brand_id: 1,
  categories: [102],
  is_visible: true,
  is_featured: false,
  custom_url: { url: '/16x25x4-merv-13-furnace-filter/', is_customized: true },
  page_title: '',
  meta_description: '',
  description: '',
  custom_fields: [],
  images: [
    {
      id: 3,
      product_id: 303,
      url_standard: 'std',
      url_zoom: 'zoom',
      is_thumbnail: true,
      sort_order: 0,
      description: 'alt en',
    },
  ],
  variants: [
    {
      id: 4003,
      product_id: 303,
      sku: 'FF-16x25x4-M13-EN',
      upc: null,
      price: 39.99,
      weight: 2.5,
      option_values: [
        { option_display_name: 'Size', label: '16x25x4' },
        { option_display_name: 'MERV', label: '13' },
      ],
    },
  ],
};

const productC_fr: BigCommerceProduct = {
  id: 402,
  name: 'Filtre de fournaise 16x25x4 MERV 13',
  sku: 'FF-16x25x4-M13-FR',
  price: 39.99,
  cost_price: 18,
  retail_price: 44.99,
  weight: 2.5,
  brand_id: 11,
  categories: [],
  is_visible: true,
  is_featured: false,
  custom_url: { url: '/filtre-fournaise-16x25x4-merv-13/', is_customized: true },
  page_title: '',
  meta_description: '',
  description: '',
  custom_fields: [],
  images: [
    {
      id: 4,
      product_id: 402,
      url_standard: 'std',
      url_zoom: 'zoom',
      is_thumbnail: true,
      sort_order: 0,
      description: 'alt fr',
    },
  ],
  variants: [
    {
      id: 5002,
      product_id: 402,
      sku: 'FF-16x25x4-M13-FR',
      upc: null,
      price: 39.99,
      weight: 2.5,
      option_values: [
        { option_display_name: 'Taille', label: '16x25x4' },
        { option_display_name: 'MERV', label: '13' },
      ],
    },
  ],
};

// --- Produits G et H : EN seulement, sans marque, SKU EN DOUBLE entre eux
//     (anomalie de données à détecter et neutraliser à l'import).
const productG_en: BigCommerceProduct = {
  id: 306,
  name: 'Universal Test Filter A',
  sku: 'FF-DUPLICATE-1',
  price: 9.99,
  cost_price: 4,
  retail_price: 12.99,
  weight: 0.5,
  brand_id: null,
  categories: [],
  is_visible: true,
  is_featured: false,
  custom_url: { url: '/universal-test-filter-a/', is_customized: true },
  page_title: '',
  meta_description: '',
  description: '',
  custom_fields: [],
  images: [
    {
      id: 5,
      product_id: 306,
      url_standard: 'std',
      url_zoom: 'zoom',
      is_thumbnail: true,
      sort_order: 0,
      description: 'alt g',
    },
  ],
  variants: [
    {
      id: 4004,
      product_id: 306,
      sku: 'FF-DUPLICATE-1',
      upc: null,
      price: 9.99,
      weight: 0.5,
      option_values: [
        { option_display_name: 'Size', label: '14x20x1' },
        { option_display_name: 'MERV', label: '8' },
      ],
    },
  ],
};

const productH_en: BigCommerceProduct = {
  id: 307,
  name: 'Universal Test Filter B',
  sku: 'FF-DUPLICATE-1',
  price: 9.99,
  cost_price: 4,
  retail_price: 12.99,
  weight: 0.5,
  brand_id: null,
  categories: [],
  is_visible: true,
  is_featured: false,
  custom_url: { url: '/universal-test-filter-b/', is_customized: true },
  page_title: '',
  meta_description: '',
  description: '',
  custom_fields: [],
  images: [],
  variants: [
    {
      id: 4005,
      product_id: 307,
      sku: 'FF-DUPLICATE-1',
      upc: null,
      price: 9.99,
      weight: 0.5,
      option_values: [
        { option_display_name: 'Size', label: '20x20x1' },
        { option_display_name: 'MERV', label: '8' },
      ],
    },
    // Produit « à modèle » (ex. filtre d'échangeur d'air) : aucune dimension
    // repérable — non importable (le schéma exige une taille), signalé au rapport.
    {
      id: 4006,
      product_id: 307,
      sku: 'FF-MODEL-ONLY-EN',
      upc: null,
      price: 39.99,
      weight: 0.4,
      option_values: [{ option_display_name: 'MERV', label: '8' }],
    },
  ],
};

const enPages: BigCommercePage[] = [
  { id: 900, name: 'About Us', type: 'page', is_visible: true, url: '/about-us/' },
];
const frPages: BigCommercePage[] = [
  { id: 901, name: 'À propos', type: 'page', is_visible: true, url: '/a-propos/' },
];

export function buildFixtureCatalogExport(): CatalogExport {
  return {
    fetchedAt: '2026-07-06T12:00:00.000Z',
    stores: {
      en: {
        store: 'en',
        domain: 'furnacefilterscanada.com',
        fetchedAt: '2026-07-06T12:00:00.000Z',
        brands: enBrands,
        categories: enCategories,
        products: [productA_en, productB_en, productC_en, productG_en, productH_en],
        pages: enPages,
      },
      fr: {
        store: 'fr',
        domain: 'filtrationmontreal.com',
        fetchedAt: '2026-07-06T12:00:00.000Z',
        brands: frBrands,
        categories: frCategories,
        products: [productA_fr, productC_fr],
        pages: frPages,
      },
    },
  };
}
