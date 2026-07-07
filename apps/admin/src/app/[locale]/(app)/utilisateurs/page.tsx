'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Field, Input, Modal, Spinner } from '@/components/ui';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type AdminRole, type AdminUser } from '@/lib/types';

type ModalState = { kind: 'invite' } | { kind: 'roles'; user: AdminUser } | null;

export default function UsersPage() {
  const t = useTranslations('admin.users');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const { request, mutate } = useAdminAuth();

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const roleLabel = useCallback(
    (role: { nameFr: string; nameEn: string }) => (locale === 'fr' ? role.nameFr : role.nameEn),
    [locale],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [userList, roleList] = await Promise.all([
        request<AdminUser[]>('/admin/users'),
        request<AdminRole[]>('/admin/roles'),
      ]);
      setUsers(userList);
      setRoles(roleList);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : tc('error'));
      setUsers([]);
    }
  }, [request, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  function report(err: unknown): void {
    if (err instanceof AdminApiError && err.code === 'CANCELLED') return;
    setError(err instanceof AdminApiError ? err.message : tc('error'));
  }

  async function invite(body: {
    email: string;
    firstName?: string;
    lastName?: string;
    roleKeys: string[];
  }): Promise<void> {
    await mutate('/admin/users/invitations', { method: 'POST', body });
    setModal(null);
    setNotice(t('inviteSuccess', { email: body.email }));
    await load();
  }

  async function saveRoles(user: AdminUser, roleKeys: string[]): Promise<void> {
    await mutate(`/admin/users/${user.id}/roles`, { method: 'PATCH', body: { roleKeys } });
    setModal(null);
    setNotice(t('rolesSuccess'));
    await load();
  }

  async function toggleActive(user: AdminUser): Promise<void> {
    const activating = user.status === 'DISABLED';
    if (!activating && !window.confirm(t('deactivateConfirm', { email: user.email }))) return;
    try {
      await mutate(`/admin/users/${user.id}/${activating ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: {},
      });
      setNotice(activating ? t('reactivateSuccess') : t('deactivateSuccess'));
      await load();
    } catch (err) {
      report(err);
    }
  }

  const dateFmt = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('title')}</h1>
        <div className="page-actions">
          <Button onClick={() => void load()}>{t('refresh')}</Button>
          <Button variant="primary" onClick={() => setModal({ kind: 'invite' })}>
            {t('invite')}
          </Button>
        </div>
      </header>

      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      {!users ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : users.length === 0 ? (
        <p className="page-empty">{t('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('colName')}</th>
                <th>{t('colEmail')}</th>
                <th>{t('colRoles')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('colLastLogin')}</th>
                <th className="col-actions">{t('colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{[user.firstName, user.lastName].filter(Boolean).join(' ') || tc('none')}</td>
                  <td className="cell-mono">{user.email}</td>
                  <td>
                    <div className="chip-row">
                      {user.roles.length === 0 ? (
                        <span className="muted">{t('noRoles')}</span>
                      ) : (
                        user.roles.map((role) => (
                          <Badge key={role.key} tone="neutral">
                            {roleLabel(role)}
                          </Badge>
                        ))
                      )}
                    </div>
                  </td>
                  <td>
                    {user.invitedPendingAt ? (
                      <Badge tone="warn">{t('statusPending')}</Badge>
                    ) : user.status === 'DISABLED' ? (
                      <Badge tone="muted">{t('statusDisabled')}</Badge>
                    ) : (
                      <Badge tone="ok">{t('statusActive')}</Badge>
                    )}
                  </td>
                  <td>
                    {user.lastLoginAt ? dateFmt.format(new Date(user.lastLoginAt)) : t('never')}
                  </td>
                  <td className="col-actions">
                    <button className="link-btn" onClick={() => setModal({ kind: 'roles', user })}>
                      {t('changeRoles')}
                    </button>
                    <button
                      className={user.status === 'DISABLED' ? 'link-btn' : 'link-btn danger'}
                      onClick={() => void toggleActive(user)}
                    >
                      {user.status === 'DISABLED' ? t('reactivate') : t('deactivate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'invite' ? (
        <InviteModal
          roles={roles}
          roleLabel={roleLabel}
          onClose={() => setModal(null)}
          onSubmit={invite}
        />
      ) : null}
      {modal?.kind === 'roles' ? (
        <RolesModal
          user={modal.user}
          roles={roles}
          roleLabel={roleLabel}
          onClose={() => setModal(null)}
          onSubmit={(keys) => saveRoles(modal.user, keys)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------- Sous-fenêtres ----------------------------- */

/** Ajoute ou retire une clé d'un Set (copie immuable pour setState). */
function toggleKey(previous: Set<string>, key: string): Set<string> {
  const next = new Set(previous);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function RoleCheckboxes({
  roles,
  selected,
  onToggle,
  roleLabel,
}: {
  roles: AdminRole[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  roleLabel: (role: AdminRole) => string;
}) {
  return (
    <div className="checkbox-list">
      {roles.map((role) => (
        <label key={role.key} className="checkbox">
          <input
            type="checkbox"
            checked={selected.has(role.key)}
            onChange={() => onToggle(role.key)}
          />
          <span>
            <strong>{roleLabel(role)}</strong>
            {role.description ? <em>{role.description}</em> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

function InviteModal({
  roles,
  roleLabel,
  onClose,
  onSubmit,
}: {
  roles: AdminRole[];
  roleLabel: (role: AdminRole) => string;
  onClose: () => void;
  onSubmit: (body: {
    email: string;
    firstName?: string;
    lastName?: string;
    roleKeys: string[];
  }) => Promise<void>;
}) {
  const t = useTranslations('admin.users');
  const tc = useTranslations('admin.common');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggle(key: string): void {
    setSelected((prev) => toggleKey(prev, key));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selected.size === 0) {
      setError(t('selectAtLeastOne'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        roleKeys: [...selected],
      });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={t('inviteTitle')} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('inviteEmail')}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </Field>
        <div className="field-row">
          <Field label={t('inviteFirstName')}>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </Field>
          <Field label={t('inviteLastName')}>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <Field label={t('inviteRoles')}>
          <RoleCheckboxes
            roles={roles}
            selected={selected}
            onToggle={toggle}
            roleLabel={roleLabel}
          />
        </Field>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {t('inviteSend')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RolesModal({
  user,
  roles,
  roleLabel,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  roles: AdminRole[];
  roleLabel: (role: AdminRole) => string;
  onClose: () => void;
  onSubmit: (roleKeys: string[]) => Promise<void>;
}) {
  const t = useTranslations('admin.users');
  const tc = useTranslations('admin.common');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(user.roles.map((role) => role.key)),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggle(key: string): void {
    setSelected((prev) => toggleKey(prev, key));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit([...selected]);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={t('rolesTitle', { email: user.email })} onClose={onClose}>
      <form onSubmit={submit}>
        <RoleCheckboxes roles={roles} selected={selected} onToggle={toggle} roleLabel={roleLabel} />
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {t('rolesSave')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
