'use client';

import { type ReactNode, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { useAdminAuth } from '@/lib/auth-context';
import { Spinner } from './ui';

/** Déconnexion automatique après cette durée d'inactivité (session admin brève). */
const IDLE_LOGOUT_MS = 15 * 60_000;

interface NavItem {
  href: '/tableau-de-bord' | '/utilisateurs' | '/journal' | '/shipstation';
  label: string;
  permission?: string;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { status, profile, can, logout } = useAdminAuth();

  // Garde : renvoie à la connexion dès qu'on est anonyme.
  useEffect(() => {
    if (status === 'anonymous') router.replace('/connexion');
  }, [status, router]);

  // Déconnexion sur inactivité — la session admin reste volontairement courte.
  useEffect(() => {
    if (status !== 'authenticated') return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => void logout(), IDLE_LOGOUT_MS);
    };
    const events = ['mousemove', 'keydown', 'click', 'scroll'] as const;
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [status, logout]);

  if (status !== 'authenticated' || !profile) {
    return (
      <div className="shell-loading">
        <Spinner />
      </div>
    );
  }

  const navItems: NavItem[] = [
    { href: '/tableau-de-bord', label: t('nav.dashboard') },
    { href: '/shipstation', label: t('nav.shipstation'), permission: 'shipments.read' },
    { href: '/utilisateurs', label: t('nav.users'), permission: 'admin_users.read' },
    { href: '/journal', label: t('nav.audit'), permission: 'audit.read' },
  ];
  const otherLocale = locale === 'fr' ? 'en' : 'fr';

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          <strong>{t('brand')}</strong>
          <span>{t('brandSuffix')}</span>
        </div>
        <nav className="shell-nav" aria-label={t('brandSuffix')}>
          {navItems
            .filter((item) => !item.permission || can(item.permission))
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={pathname === item.href ? 'shell-nav-link active' : 'shell-nav-link'}
              >
                {item.label}
              </Link>
            ))}
        </nav>
        <div className="shell-footer">
          <p className="shell-user" title={profile.email}>
            {t('nav.signedInAs', { email: profile.email })}
          </p>
          <div className="shell-footer-actions">
            <Link href={pathname} locale={otherLocale} className="shell-nav-link">
              {t('nav.languageSwitch')}
            </Link>
            <button type="button" className="shell-logout" onClick={() => void logout()}>
              {t('nav.logout')}
            </button>
          </div>
        </div>
      </aside>
      <main className="shell-main">{children}</main>
    </div>
  );
}
