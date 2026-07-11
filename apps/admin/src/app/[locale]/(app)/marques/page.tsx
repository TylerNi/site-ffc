'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button, Field, Input, Modal, Spinner } from '@/components/ui';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type AdminBrand } from '@/lib/types';

type ModalState = { kind: 'create' } | { kind: 'edit'; brand: AdminBrand } | null;

export default function BrandsPage() {
  const t = useTranslations('admin.brands');
  const tc = useTranslations('admin.common');
  const { request, can } = useAdminAuth();
  const canWrite = can('products.write');

  const [brands, setBrands] = useState<AdminBrand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setBrands(await request<AdminBrand[]>('/admin/brands'));
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : tc('error'));
      setBrands([]);
    }
  }, [request, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: {
    slug: string;
    name: string;
    logoUrl?: string;
    isActive?: boolean;
  }): Promise<void> {
    if (modal?.kind === 'edit') {
      await request(`/admin/brands/${modal.brand.id}`, { method: 'PATCH', body });
      setNotice(t('updated'));
    } else {
      await request('/admin/brands', { method: 'POST', body });
      setNotice(t('created'));
    }
    setModal(null);
    await load();
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('title')}</h1>
        {canWrite ? (
          <div className="page-actions">
            <Button variant="primary" onClick={() => setModal({ kind: 'create' })}>
              {t('newBrand')}
            </Button>
          </div>
        ) : null}
      </header>

      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      {!brands ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : brands.length === 0 ? (
        <p className="page-empty">{t('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('colName')}</th>
                <th>{t('colSlug')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('colProducts')}</th>
                {canWrite ? <th className="col-actions">{tc('none')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {brands.map((brand) => (
                <tr key={brand.id}>
                  <td>{brand.name}</td>
                  <td className="cell-mono">{brand.slug}</td>
                  <td>
                    <Badge tone={brand.isActive ? 'ok' : 'muted'}>
                      {brand.isActive ? t('active') : t('inactive')}
                    </Badge>
                  </td>
                  <td>{brand.productCount}</td>
                  {canWrite ? (
                    <td className="col-actions">
                      <button
                        className="link-btn"
                        onClick={() => setModal({ kind: 'edit', brand })}
                      >
                        {t('edit')}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal ? (
        <BrandModal
          brand={modal.kind === 'edit' ? modal.brand : null}
          onClose={() => setModal(null)}
          onSubmit={save}
        />
      ) : null}
    </div>
  );
}

function BrandModal({
  brand,
  onClose,
  onSubmit,
}: {
  brand: AdminBrand | null;
  onClose: () => void;
  onSubmit: (body: {
    slug: string;
    name: string;
    logoUrl?: string;
    isActive?: boolean;
  }) => Promise<void>;
}) {
  const t = useTranslations('admin.brands');
  const tc = useTranslations('admin.common');
  const [slug, setSlug] = useState(brand?.slug ?? '');
  const [name, setName] = useState(brand?.name ?? '');
  const [logoUrl, setLogoUrl] = useState(brand?.logoUrl ?? '');
  const [isActive, setIsActive] = useState(brand?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        slug: slug.trim(),
        name: name.trim(),
        logoUrl: logoUrl.trim() || undefined,
        isActive,
      });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={brand ? t('edit') : t('newBrand')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </Field>
        <Field label={t('slug')}>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} required />
        </Field>
        <Field label={t('logoUrl')}>
          <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
        </Field>
        {brand ? (
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
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
