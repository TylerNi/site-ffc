'use client';

import { type DragEvent, type FormEvent, useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { AdjustModal } from '@/components/StockModals';
import { Link, useRouter } from '@/i18n/navigation';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import {
  type AdminBrand,
  type AdminLocale,
  type CategoryNode,
  type ProductDetail,
  type ProductImage,
  type ProductStatus,
  type ProductTranslation,
  type ProductVariant,
} from '@/lib/types';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const STATUS_TONES: Record<ProductStatus, 'ok' | 'warn' | 'muted'> = {
  DRAFT: 'warn',
  ACTIVE: 'ok',
  ARCHIVED: 'muted',
};

function flatten(nodes: CategoryNode[], depth = 0): Array<{ node: CategoryNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

function pickName(node: CategoryNode): string {
  return (
    node.translations.find((t) => t.locale === 'fr')?.name ?? node.translations[0]?.name ?? '—'
  );
}

function dollarsToCents(value: string): number {
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function centsToDollars(cents: number | null | undefined): string {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Lecture du fichier échouée.'));
    reader.readAsDataURL(file);
  });
}

async function performUpload(
  file: File,
  presigned: { url: string; fields: Record<string, string> },
): Promise<void> {
  if (presigned.url.endsWith('/dev/uploads')) {
    // Relais dev/test (pas de bucket S3 configuré) — voir dev-upload.controller.ts.
    const dataBase64 = await fileToBase64(file);
    const res = await fetch(presigned.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: presigned.fields.key, dataBase64 }),
    });
    if (!res.ok) throw new Error('Échec du téléversement.');
    return;
  }
  const form = new FormData();
  Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, value));
  form.append('file', file);
  const res = await fetch(presigned.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Échec du téléversement.');
}

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const productId = params.id;
  const t = useTranslations('admin.products');
  const tc = useTranslations('admin.common');
  const { request, can } = useAdminAuth();
  const canWrite = can('products.write');
  const router = useRouter();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [variantModal, setVariantModal] = useState<{ variant: ProductVariant | null } | null>(null);
  const [stockModalVariant, setStockModalVariant] = useState<ProductVariant | null>(null);
  const [dragImageId, setDragImageId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProduct(await request<ProductDetail>(`/admin/products/${productId}`));
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : tc('error'));
    }
  }, [request, productId, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void request<AdminBrand[]>('/admin/brands')
      .then(setBrands)
      .catch(() => undefined);
    void request<{ categories: CategoryNode[] }>('/admin/categories')
      .then((data) => setCategories(data.categories))
      .catch(() => undefined);
  }, [request]);

  async function runStatusAction(
    action: 'publish' | 'unpublish' | 'archive' | 'restore' | 'duplicate',
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await request<ProductDetail>(`/admin/products/${productId}/${action}`, {
        method: 'POST',
        body: {},
      });
      setProduct(result);
      switch (action) {
        case 'publish':
          setNotice(t('published'));
          break;
        case 'unpublish':
          setNotice(t('unpublished'));
          break;
        case 'archive':
          setNotice(t('archived'));
          break;
        case 'restore':
          setNotice(t('restored'));
          break;
        case 'duplicate':
          router.push(`/catalogue/${result.id}`);
          break;
      }
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails(
    brandId: string,
    categoryId: string,
    isFeatured: boolean,
  ): Promise<void> {
    const updated = await request<ProductDetail>(`/admin/products/${productId}`, {
      method: 'PATCH',
      body: { brandId, categoryId: categoryId || null, isFeatured },
    });
    setProduct(updated);
    setNotice(t('detailsSaved'));
  }

  async function saveTranslation(
    locale: AdminLocale,
    dto: Partial<ProductTranslation>,
  ): Promise<void> {
    const updated = await request<ProductDetail>(
      `/admin/products/${productId}/translations/${locale}`,
      {
        method: 'PATCH',
        body: dto,
      },
    );
    setProduct(updated);
    setNotice(t('translationSaved'));
  }

  async function saveVariant(
    variantId: string | null,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (variantId) {
      await request(`/admin/products/${productId}/variants/${variantId}`, {
        method: 'PATCH',
        body,
      });
    } else {
      await request(`/admin/products/${productId}/variants`, { method: 'POST', body });
    }
    setVariantModal(null);
    setNotice(t('variantSaved'));
    await load();
  }

  async function deleteVariant(variant: ProductVariant): Promise<void> {
    if (!window.confirm(t('confirmDeleteVariant'))) return;
    try {
      await request(`/admin/products/${productId}/variants/${variant.id}`, { method: 'DELETE' });
      setNotice(t('variantDeleted'));
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
    }
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setError(t('imageInvalidType'));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(t('imageTooLarge'));
        continue;
      }
      setUploading(true);
      setError(null);
      try {
        const presigned = await request<{
          key: string;
          url: string;
          fields: Record<string, string>;
        }>(`/admin/products/${productId}/images/upload-url`, {
          method: 'POST',
          body: { contentType: file.type },
        });
        await performUpload(file, presigned);
        const registered = await request<ProductImage>(`/admin/products/${productId}/images`, {
          method: 'POST',
          body: { key: presigned.key },
        });
        setProduct((prev) => (prev ? { ...prev, images: [...prev.images, registered] } : prev));
      } catch (err) {
        setError(err instanceof AdminApiError ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    }
  }

  async function updateImage(image: ProductImage, patch: Partial<ProductImage>): Promise<void> {
    const updated = await request<ProductImage>(`/admin/products/${productId}/images/${image.id}`, {
      method: 'PATCH',
      body: { altFr: patch.altFr, altEn: patch.altEn },
    });
    setProduct((prev) =>
      prev
        ? { ...prev, images: prev.images.map((i) => (i.id === updated.id ? updated : i)) }
        : prev,
    );
  }

  async function deleteImage(image: ProductImage): Promise<void> {
    if (!window.confirm(t('confirmDeleteImage'))) return;
    try {
      await request(`/admin/products/${productId}/images/${image.id}`, { method: 'DELETE' });
      setProduct((prev) =>
        prev ? { ...prev, images: prev.images.filter((i) => i.id !== image.id) } : prev,
      );
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
    }
  }

  async function reorderImages(imageIds: string[]): Promise<void> {
    const reordered = await request<ProductImage[]>(`/admin/products/${productId}/images/order`, {
      method: 'PUT',
      body: { imageIds },
    });
    setProduct((prev) => (prev ? { ...prev, images: reordered } : prev));
  }

  function onImageDrop(targetId: string): void {
    if (!product || !dragImageId || dragImageId === targetId) {
      setDragImageId(null);
      return;
    }
    const ids = product.images.map((i) => i.id);
    const from = ids.indexOf(dragImageId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragImageId);
    setDragImageId(null);
    void reorderImages(ids);
  }

  if (error && !product) {
    return (
      <div className="page">
        <Alert kind="error">{error}</Alert>
      </div>
    );
  }
  if (!product) {
    return (
      <div className="page-loading">
        <Spinner />
      </div>
    );
  }

  const name = product.translations.find((tr) => tr.locale === 'fr')?.name ?? t('untitled');
  const missingLocales = (['fr', 'en'] as const).filter(
    (loc) => !product.translations.some((tr) => tr.locale === loc),
  );

  return (
    <div className="page">
      <p>
        <Link href="/catalogue">{t('backToList')}</Link>
      </p>
      <header className="page-header">
        <div>
          <h1>
            {name}{' '}
            <Badge tone={STATUS_TONES[product.status]}>
              {t(`status${capitalize(product.status)}`)}
            </Badge>
          </h1>
        </div>
        {canWrite ? (
          <div className="detail-actions">
            {product.status === 'DRAFT' ? (
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void runStatusAction('publish')}
              >
                {t('publish')}
              </Button>
            ) : null}
            {product.status === 'ACTIVE' ? (
              <Button loading={busy} onClick={() => void runStatusAction('unpublish')}>
                {t('unpublish')}
              </Button>
            ) : null}
            {product.status !== 'ARCHIVED' ? (
              <Button
                variant="danger"
                loading={busy}
                onClick={() => {
                  if (window.confirm(t('confirmArchive'))) void runStatusAction('archive');
                }}
              >
                {t('archive')}
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void runStatusAction('restore')}
              >
                {t('restore')}
              </Button>
            )}
            <Button loading={busy} onClick={() => void runStatusAction('duplicate')}>
              {t('duplicate')}
            </Button>
          </div>
        ) : null}
      </header>

      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      <section className="card">
        <h2 className="section-title">{t('sectionDetails')}</h2>
        <DetailsForm
          product={product}
          brands={brands}
          categories={categories}
          canWrite={canWrite}
          onSave={saveDetails}
        />
      </section>

      <section className="card">
        <h2 className="section-title">{t('sectionTranslations')}</h2>
        <div className="locale-columns">
          {(['fr', 'en'] as const).map((loc) => (
            <TranslationColumn
              key={loc}
              locale={loc}
              translation={product.translations.find((tr) => tr.locale === loc) ?? null}
              missing={missingLocales.includes(loc)}
              canWrite={canWrite}
              onSave={(dto) => saveTranslation(loc, dto)}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">{t('sectionVariants')}</h2>
        {canWrite ? (
          <div className="page-actions" style={{ marginBottom: '1rem' }}>
            <Button variant="primary" onClick={() => setVariantModal({ variant: null })}>
              {t('addVariant')}
            </Button>
          </div>
        ) : null}
        {product.variants.length === 0 ? (
          <p className="page-empty">{t('noVariants')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sku')}</th>
                  <th>{t('nominalLabel')}</th>
                  <th>{t('merv')}</th>
                  <th>{t('priceDollars')}</th>
                  <th>{t('stock')}</th>
                  <th>{t('active')}</th>
                  {canWrite ? <th className="col-actions">{tc('none')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {product.variants.map((variant) => (
                  <tr key={variant.id}>
                    <td className="cell-mono">{variant.sku}</td>
                    <td>{variant.nominalLabel}</td>
                    <td>{variant.merv ?? '—'}</td>
                    <td>{centsToDollars(variant.priceCents)} $</td>
                    <td>
                      {variant.inventory?.quantityOnHand ?? 0}
                      {variant.inventory?.lowStockThreshold != null &&
                      variant.inventory.quantityOnHand <= variant.inventory.lowStockThreshold ? (
                        <Badge tone="warn">!</Badge>
                      ) : null}
                    </td>
                    <td>{variant.isActive ? '✓' : '—'}</td>
                    {canWrite ? (
                      <td className="col-actions">
                        <button className="link-btn" onClick={() => setStockModalVariant(variant)}>
                          {t('adjustStock')}
                        </button>
                        <button className="link-btn" onClick={() => setVariantModal({ variant })}>
                          {tc('save')}
                        </button>
                        <button
                          className="link-btn danger"
                          onClick={() => void deleteVariant(variant)}
                        >
                          {t('deleteVariant')}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="section-title">{t('sectionImages')}</h2>
        {canWrite ? (
          <>
            <p className="section-hint">{t('dropHint')}</p>
            <div className="page-actions" style={{ marginBottom: '1rem' }}>
              <label className="btn btn-primary">
                {uploading ? t('uploading') : t('addImage')}
                <input
                  type="file"
                  accept={ALLOWED_IMAGE_TYPES.join(',')}
                  multiple
                  style={{ display: 'none' }}
                  disabled={uploading}
                  onChange={(e) => {
                    void handleFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </>
        ) : null}
        {product.images.length === 0 ? (
          <p className="page-empty">{t('noImages')}</p>
        ) : (
          <div className="image-grid">
            {product.images.map((image, index) => (
              <ImageCard
                key={image.id}
                image={image}
                primary={index === 0}
                canWrite={canWrite}
                dragging={dragImageId === image.id}
                onDragStart={() => setDragImageId(image.id)}
                onDragOver={(e: DragEvent) => e.preventDefault()}
                onDrop={() => onImageDrop(image.id)}
                onChange={(patch) => void updateImage(image, patch)}
                onDelete={() => void deleteImage(image)}
              />
            ))}
          </div>
        )}
      </section>

      {variantModal ? (
        <VariantModal
          variant={variantModal.variant}
          onClose={() => setVariantModal(null)}
          onSubmit={(body) => saveVariant(variantModal.variant?.id ?? null, body)}
        />
      ) : null}

      {stockModalVariant ? (
        <AdjustModal
          item={{ variantId: stockModalVariant.id, sku: stockModalVariant.sku }}
          onClose={() => setStockModalVariant(null)}
          onSubmit={async (body) => {
            await request(`/admin/inventory/${stockModalVariant.id}/adjustments`, {
              method: 'POST',
              body,
            });
            setStockModalVariant(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function capitalize(status: ProductStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/* ------------------------------- Détails ------------------------------- */

function DetailsForm({
  product,
  brands,
  categories,
  canWrite,
  onSave,
}: {
  product: ProductDetail;
  brands: AdminBrand[];
  categories: CategoryNode[];
  canWrite: boolean;
  onSave: (brandId: string, categoryId: string, isFeatured: boolean) => Promise<void>;
}) {
  const t = useTranslations('admin.products');
  const [brandId, setBrandId] = useState(product.brand.id);
  const [categoryId, setCategoryId] = useState(product.category?.id ?? '');
  const [isFeatured, setIsFeatured] = useState(product.isFeatured);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const flatCategories = flatten(categories);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSave(brandId, categoryId, isFeatured);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field-row">
        <Field label={t('brand')}>
          <Select value={brandId} disabled={!canWrite} onChange={(e) => setBrandId(e.target.value)}>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('category')}>
          <Select
            value={categoryId}
            disabled={!canWrite}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t('noCategory')}</option>
            {flatCategories.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {'— '.repeat(depth)}
                {pickName(node)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="checkbox" style={{ marginBottom: '1rem' }}>
        <input
          type="checkbox"
          checked={isFeatured}
          disabled={!canWrite}
          onChange={(e) => setIsFeatured(e.target.checked)}
        />
        <span>{t('featured')}</span>
      </label>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {canWrite ? (
        <Button type="submit" variant="primary" loading={submitting}>
          {t('saveDetails')}
        </Button>
      ) : null}
    </form>
  );
}

/* ----------------------------- Traductions ----------------------------- */

function TranslationColumn({
  locale,
  translation,
  missing,
  canWrite,
  onSave,
}: {
  locale: AdminLocale;
  translation: ProductTranslation | null;
  missing: boolean;
  canWrite: boolean;
  onSave: (dto: {
    name: string;
    slug: string;
    shortDescription?: string;
    description?: string;
    metaTitle?: string;
    metaDescription?: string;
  }) => Promise<void>;
}) {
  const t = useTranslations('admin.products');
  const [name, setName] = useState(translation?.name ?? '');
  const [slug, setSlug] = useState(translation?.slug ?? '');
  const [shortDescription, setShortDescription] = useState(translation?.shortDescription ?? '');
  const [description, setDescription] = useState(translation?.description ?? '');
  const [metaTitle, setMetaTitle] = useState(translation?.metaTitle ?? '');
  const [metaDescription, setMetaDescription] = useState(translation?.metaDescription ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSave({
        name: name.trim(),
        slug: slug.trim(),
        shortDescription: shortDescription.trim() || undefined,
        description: description.trim() || undefined,
        metaTitle: metaTitle.trim() || undefined,
        metaDescription: metaDescription.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="locale-column-head">
        <strong>{locale.toUpperCase()}</strong>
        {missing ? <Badge tone="warn">{t('missingTranslation')}</Badge> : null}
      </div>
      <Field label={t('name')}>
        <Input
          value={name}
          disabled={!canWrite}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      <Field label={t('slug')}>
        <Input
          value={slug}
          disabled={!canWrite}
          onChange={(e) => setSlug(e.target.value)}
          required
        />
      </Field>
      <Field label={t('shortDescription')}>
        <Input
          value={shortDescription}
          disabled={!canWrite}
          onChange={(e) => setShortDescription(e.target.value)}
        />
      </Field>
      <Field label={t('description')}>
        <Textarea
          value={description}
          disabled={!canWrite}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label={t('metaTitle')}>
        <Input
          value={metaTitle}
          disabled={!canWrite}
          onChange={(e) => setMetaTitle(e.target.value)}
        />
      </Field>
      <Field label={t('metaDescription')}>
        <Textarea
          value={metaDescription}
          disabled={!canWrite}
          onChange={(e) => setMetaDescription(e.target.value)}
        />
      </Field>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {canWrite ? (
        <Button type="submit" variant="primary" loading={submitting}>
          {t('saveTranslation')}
        </Button>
      ) : null}
    </form>
  );
}

/* ------------------------------- Variantes ------------------------------ */

function VariantModal({
  variant,
  onClose,
  onSubmit,
}: {
  variant: ProductVariant | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations('admin.products');
  const tc = useTranslations('admin.common');
  const [sku, setSku] = useState(variant?.sku ?? '');
  const [barcode, setBarcode] = useState(variant?.barcode ?? '');
  const [nominalLabel, setNominalLabel] = useState(variant?.nominalLabel ?? '');
  const [nominalWidthIn, setNominalWidthIn] = useState(variant?.nominalWidthIn.toString() ?? '');
  const [nominalHeightIn, setNominalHeightIn] = useState(variant?.nominalHeightIn.toString() ?? '');
  const [nominalDepthIn, setNominalDepthIn] = useState(variant?.nominalDepthIn.toString() ?? '');
  const [actualWidthIn, setActualWidthIn] = useState(variant?.actualWidthIn.toString() ?? '');
  const [actualHeightIn, setActualHeightIn] = useState(variant?.actualHeightIn.toString() ?? '');
  const [actualDepthIn, setActualDepthIn] = useState(variant?.actualDepthIn.toString() ?? '');
  const [merv, setMerv] = useState(variant?.merv?.toString() ?? '');
  const [packSize, setPackSize] = useState(variant?.packSize.toString() ?? '1');
  const [priceDollars, setPriceDollars] = useState(
    centsToDollars(variant?.priceCents ?? 0) || '0.00',
  );
  const [compareAtDollars, setCompareAtDollars] = useState(
    centsToDollars(variant?.compareAtPriceCents),
  );
  const [costDollars, setCostDollars] = useState(centsToDollars(variant?.costCents));
  const [weightGrams, setWeightGrams] = useState(variant?.weightGrams?.toString() ?? '');
  const [isActive, setIsActive] = useState(variant?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        sku: sku.trim(),
        barcode: barcode.trim() || undefined,
        nominalLabel: nominalLabel.trim(),
        nominalWidthIn: Number.parseFloat(nominalWidthIn),
        nominalHeightIn: Number.parseFloat(nominalHeightIn),
        nominalDepthIn: Number.parseFloat(nominalDepthIn),
        actualWidthIn: Number.parseFloat(actualWidthIn),
        actualHeightIn: Number.parseFloat(actualHeightIn),
        actualDepthIn: Number.parseFloat(actualDepthIn),
        merv: merv.trim() ? Number.parseInt(merv, 10) : undefined,
        packSize: Number.parseInt(packSize, 10),
        priceCents: dollarsToCents(priceDollars),
        compareAtPriceCents: compareAtDollars.trim() ? dollarsToCents(compareAtDollars) : undefined,
        costCents: costDollars.trim() ? dollarsToCents(costDollars) : undefined,
        weightGrams: weightGrams.trim() ? Number.parseInt(weightGrams, 10) : undefined,
        ...(variant ? { isActive } : {}),
      });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={variant ? t('editVariant') : t('addVariant')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field-row">
          <Field label={t('sku')}>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} required />
          </Field>
          <Field label={t('barcode')}>
            <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} />
          </Field>
        </div>
        <Field label={t('nominalLabel')}>
          <Input
            value={nominalLabel}
            onChange={(e) => setNominalLabel(e.target.value)}
            placeholder="16x25x1"
            required
          />
        </Field>

        <p className="field-label">{t('nominalDimensions')}</p>
        <div className="variant-form-grid">
          <Input
            type="number"
            step="0.01"
            placeholder={t('width')}
            value={nominalWidthIn}
            onChange={(e) => setNominalWidthIn(e.target.value)}
            required
          />
          <Input
            type="number"
            step="0.01"
            placeholder={t('height')}
            value={nominalHeightIn}
            onChange={(e) => setNominalHeightIn(e.target.value)}
            required
          />
          <Input
            type="number"
            step="0.01"
            placeholder={t('depth')}
            value={nominalDepthIn}
            onChange={(e) => setNominalDepthIn(e.target.value)}
            required
          />
        </div>
        <p className="field-label" style={{ marginTop: '0.75rem' }}>
          {t('actualDimensions')}
        </p>
        <div className="variant-form-grid">
          <Input
            type="number"
            step="0.01"
            placeholder={t('width')}
            value={actualWidthIn}
            onChange={(e) => setActualWidthIn(e.target.value)}
            required
          />
          <Input
            type="number"
            step="0.01"
            placeholder={t('height')}
            value={actualHeightIn}
            onChange={(e) => setActualHeightIn(e.target.value)}
            required
          />
          <Input
            type="number"
            step="0.01"
            placeholder={t('depth')}
            value={actualDepthIn}
            onChange={(e) => setActualDepthIn(e.target.value)}
            required
          />
        </div>

        <div className="field-row" style={{ marginTop: '0.75rem' }}>
          <Field label={t('merv')}>
            <Input
              type="number"
              min={1}
              max={20}
              value={merv}
              onChange={(e) => setMerv(e.target.value)}
            />
          </Field>
          <Field label={t('packSize')}>
            <Input
              type="number"
              min={1}
              value={packSize}
              onChange={(e) => setPackSize(e.target.value)}
              required
            />
          </Field>
        </div>

        <div className="field-row">
          <Field label={t('priceDollars')}>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={priceDollars}
              onChange={(e) => setPriceDollars(e.target.value)}
              required
            />
          </Field>
          <Field label={t('compareAtDollars')}>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={compareAtDollars}
              onChange={(e) => setCompareAtDollars(e.target.value)}
            />
          </Field>
        </div>
        <div className="field-row">
          <Field label={t('costDollars')}>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={costDollars}
              onChange={(e) => setCostDollars(e.target.value)}
            />
          </Field>
          <Field label={t('weightGrams')}>
            <Input
              type="number"
              min={0}
              value={weightGrams}
              onChange={(e) => setWeightGrams(e.target.value)}
            />
          </Field>
        </div>

        {variant ? (
          <label className="checkbox" style={{ marginBottom: '1rem' }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>{t('active')}</span>
          </label>
        ) : null}

        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {tc('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------- Images -------------------------------- */

function imagePreviewUrl(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  const base = process.env.NEXT_PUBLIC_ASSETS_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

function ImageCard({
  image,
  primary,
  canWrite,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onChange,
  onDelete,
}: {
  image: ProductImage;
  primary: boolean;
  canWrite: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  onChange: (patch: Partial<ProductImage>) => void;
  onDelete: () => void;
}) {
  const t = useTranslations('admin.products');
  const [altFr, setAltFr] = useState(image.altFr ?? '');
  const [altEn, setAltEn] = useState(image.altEn ?? '');
  const preview = imagePreviewUrl(image.url);

  return (
    <div
      className={`image-card${dragging ? ' dragging' : ''}`}
      draggable={canWrite}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {preview ? (
        <img className="image-card-thumb" src={preview} alt={altFr || altEn || ''} />
      ) : (
        <div className="image-card-thumb" aria-hidden />
      )}
      <div className="image-card-body">
        {primary ? <Badge tone="ok">{t('primary')}</Badge> : null}
        <input
          className="input"
          placeholder={t('altFr')}
          value={altFr}
          disabled={!canWrite}
          onChange={(e) => setAltFr(e.target.value)}
          onBlur={() => onChange({ altFr })}
        />
        <input
          className="input"
          placeholder={t('altEn')}
          value={altEn}
          disabled={!canWrite}
          onChange={(e) => setAltEn(e.target.value)}
          onBlur={() => onChange({ altEn })}
        />
        {canWrite ? (
          <div className="image-card-actions">
            <button className="link-btn danger" onClick={onDelete}>
              {t('deleteImage')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
