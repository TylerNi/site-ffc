'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Field, Select } from '@/components/ui';
import { useRouter } from '@/i18n/navigation';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type AdminBrand, type CategoryNode, type ProductDetail } from '@/lib/types';

function flatten(nodes: CategoryNode[], depth = 0): Array<{ node: CategoryNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

export default function NewProductPage() {
  const t = useTranslations('admin.products');
  const tc = useTranslations('admin.common');
  const { request } = useAdminAuth();
  const router = useRouter();

  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [brandId, setBrandId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void request<AdminBrand[]>('/admin/brands')
      .then(setBrands)
      .catch(() => undefined);
    void request<{ categories: CategoryNode[] }>('/admin/categories')
      .then((data) => setCategories(data.categories))
      .catch(() => undefined);
  }, [request]);

  const flatCategories = useMemo(() => flatten(categories), [categories]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await request<ProductDetail>('/admin/products', {
        method: 'POST',
        body: { brandId, categoryId: categoryId || undefined },
      });
      router.push(`/catalogue/${created.id}`);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('newProduct')}</h1>
      </header>

      <form onSubmit={submit} style={{ maxWidth: '28rem' }}>
        <Field label={t('brand')}>
          <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} required>
            <option value="" disabled>
              {tc('none')}
            </option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('category')}>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t('noCategory')}</option>
            {flatCategories.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {'— '.repeat(depth)}
                {node.translations.find((tr) => tr.locale === 'fr')?.name ??
                  node.translations[0]?.name ??
                  '—'}
              </option>
            ))}
          </Select>
        </Field>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="submit" variant="primary" loading={submitting} disabled={!brandId}>
            {t('newProduct')}
          </Button>
        </div>
      </form>
    </div>
  );
}
