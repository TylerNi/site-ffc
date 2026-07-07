import { redirect } from '@/i18n/navigation';

export default async function AdminRootPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // Le socle authentifié (shell) redirige vers la connexion si aucune session.
  redirect({ href: '/tableau-de-bord', locale });
}
