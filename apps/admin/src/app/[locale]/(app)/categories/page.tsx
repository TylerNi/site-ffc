'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Field, Input, Modal, Select, Spinner, Textarea } from '@/components/ui';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type AdminLocale, type CategoryNode } from '@/lib/types';

interface LocaleFields {
  name: string;
  slug: string;
  description: string;
}

const EMPTY_LOCALE: LocaleFields = { name: '', slug: '', description: '' };

type ModalState =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'edit'; category: CategoryNode }
  | { kind: 'move'; category: CategoryNode }
  | null;

/** Aplatit l'arbre pour peupler les listes déroulantes « parent ». */
function flatten(nodes: CategoryNode[], depth = 0): Array<{ node: CategoryNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

/** Sous-arbre d'un nœud (lui-même inclus) — exclu des cibles de déplacement. */
function subtreeIds(node: CategoryNode): Set<string> {
  const ids = new Set<string>([node.id]);
  for (const child of node.children) for (const id of subtreeIds(child)) ids.add(id);
  return ids;
}

function nodeName(node: CategoryNode, locale: AdminLocale): string {
  return (
    node.translations.find((t) => t.locale === locale)?.name ?? node.translations[0]?.name ?? '—'
  );
}

export default function CategoriesPage() {
  const t = useTranslations('admin.categories');
  const tc = useTranslations('admin.common');
  const locale = useLocale() as AdminLocale;
  const { request, can } = useAdminAuth();
  const canWrite = can('products.write');

  const [tree, setTree] = useState<CategoryNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await request<{ categories: CategoryNode[] }>('/admin/categories');
      setTree(data.categories);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : tc('error'));
      setTree([]);
    }
  }, [request, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  const flatList = useMemo(() => (tree ? flatten(tree) : []), [tree]);

  async function submitUpsert(body: {
    parentId?: string | null;
    sortOrder?: number;
    translations: { fr?: LocaleFields; en?: LocaleFields };
  }): Promise<void> {
    if (modal?.kind === 'edit') {
      await request(`/admin/categories/${modal.category.id}`, {
        method: 'PATCH',
        body: { translations: body.translations },
      });
      setNotice(t('updated'));
    } else {
      await request('/admin/categories', {
        method: 'POST',
        body: { parentId: body.parentId ?? undefined, translations: body.translations },
      });
      setNotice(t('created'));
    }
    setModal(null);
    await load();
  }

  async function move(categoryId: string, parentId: string | null): Promise<void> {
    await request(`/admin/categories/${categoryId}/move`, { method: 'PATCH', body: { parentId } });
    setNotice(t('moved'));
    setModal(null);
    await load();
  }

  function renderNode(node: CategoryNode): ReactNode {
    return (
      <li key={node.id} className="tree-node">
        <div className="tree-row">
          <span className="tree-row-name">
            {nodeName(node, locale)}
            <span className="muted">
              {' '}
              — {node.productCount} {t('colProducts')}
            </span>
          </span>
          {canWrite ? (
            <>
              <button
                className="link-btn"
                onClick={() => setModal({ kind: 'create', parentId: node.id })}
              >
                {t('newCategory')}
              </button>
              <button
                className="link-btn"
                onClick={() => setModal({ kind: 'edit', category: node })}
              >
                {t('edit')}
              </button>
              <button
                className="link-btn"
                onClick={() => setModal({ kind: 'move', category: node })}
              >
                {t('move')}
              </button>
            </>
          ) : null}
        </div>
        {node.children.length > 0 ? (
          <ul className="tree-children">{node.children.map((child) => renderNode(child))}</ul>
        ) : null}
      </li>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('title')}</h1>
        {canWrite ? (
          <div className="page-actions">
            <Button variant="primary" onClick={() => setModal({ kind: 'create', parentId: null })}>
              {t('newCategory')}
            </Button>
          </div>
        ) : null}
      </header>

      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      {!tree ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : tree.length === 0 ? (
        <p className="page-empty">{t('empty')}</p>
      ) : (
        <ul className="tree">{tree.map((node) => renderNode(node))}</ul>
      )}

      {modal?.kind === 'create' || modal?.kind === 'edit' ? (
        <CategoryModal
          category={modal.kind === 'edit' ? modal.category : null}
          flatList={flatList}
          defaultParentId={modal.kind === 'create' ? modal.parentId : null}
          onClose={() => setModal(null)}
          onSubmit={submitUpsert}
        />
      ) : null}

      {modal?.kind === 'move' ? (
        <MoveModal
          category={modal.category}
          flatList={flatList}
          onClose={() => setModal(null)}
          onSubmit={(parentId) => move(modal.category.id, parentId)}
        />
      ) : null}
    </div>
  );
}

function localeFieldsFrom(node: CategoryNode | null, locale: AdminLocale): LocaleFields {
  const translation = node?.translations.find((t) => t.locale === locale);
  return translation
    ? { name: translation.name, slug: translation.slug, description: translation.description ?? '' }
    : EMPTY_LOCALE;
}

function CategoryModal({
  category,
  flatList,
  defaultParentId,
  onClose,
  onSubmit,
}: {
  category: CategoryNode | null;
  flatList: Array<{ node: CategoryNode; depth: number }>;
  defaultParentId: string | null;
  onClose: () => void;
  onSubmit: (body: {
    parentId?: string | null;
    translations: { fr?: LocaleFields; en?: LocaleFields };
  }) => Promise<void>;
}) {
  const t = useTranslations('admin.categories');
  const tc = useTranslations('admin.common');
  const [parentId, setParentId] = useState<string>(defaultParentId ?? '');
  const [fr, setFr] = useState<LocaleFields>(localeFieldsFrom(category, 'fr'));
  const [en, setEn] = useState<LocaleFields>(localeFieldsFrom(category, 'en'));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const translations: { fr?: LocaleFields; en?: LocaleFields } = {};
    if (fr.name.trim() && fr.slug.trim()) translations.fr = fr;
    if (en.name.trim() && en.slug.trim()) translations.en = en;
    if (!translations.fr && !translations.en) {
      setError(t('translationsHint'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ parentId: category ? undefined : parentId || null, translations });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={category ? t('edit') : t('newCategory')} onClose={onClose}>
      <form onSubmit={submit}>
        {!category ? (
          <Field label={t('parent')}>
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t('rootParent')}</option>
              {flatList.map(({ node, depth }) => (
                <option key={node.id} value={node.id}>
                  {'— '.repeat(depth)}
                  {nodeName(node, 'fr')}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {(['fr', 'en'] as const).map((loc) => {
          const value = loc === 'fr' ? fr : en;
          const setValue = loc === 'fr' ? setFr : setEn;
          return (
            <fieldset key={loc} style={{ border: 'none', padding: 0, margin: '0 0 1rem' }}>
              <div className="locale-column-head">
                <strong>{loc.toUpperCase()}</strong>
              </div>
              <Field label={t('name')}>
                <Input
                  value={value.name}
                  onChange={(e) => setValue({ ...value, name: e.target.value })}
                />
              </Field>
              <Field label={t('slug')}>
                <Input
                  value={value.slug}
                  onChange={(e) => setValue({ ...value, slug: e.target.value })}
                />
              </Field>
              <Field label={t('description')}>
                <Textarea
                  value={value.description}
                  onChange={(e) => setValue({ ...value, description: e.target.value })}
                />
              </Field>
            </fieldset>
          );
        })}

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

function MoveModal({
  category,
  flatList,
  onClose,
  onSubmit,
}: {
  category: CategoryNode;
  flatList: Array<{ node: CategoryNode; depth: number }>;
  onClose: () => void;
  onSubmit: (parentId: string | null) => Promise<void>;
}) {
  const t = useTranslations('admin.categories');
  const tc = useTranslations('admin.common');
  const [parentId, setParentId] = useState<string>(category.parentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const excluded = useMemo(() => subtreeIds(category), [category]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(parentId || null);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={t('moveTitle', { name: nodeName(category, 'fr') })} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('parent')}>
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">{t('rootParent')}</option>
            {flatList
              .filter(({ node }) => !excluded.has(node.id))
              .map(({ node, depth }) => (
                <option key={node.id} value={node.id}>
                  {'— '.repeat(depth)}
                  {nodeName(node, 'fr')}
                </option>
              ))}
          </Select>
        </Field>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {t('move')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
