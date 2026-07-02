import { redirect } from '@/i18n/navigation';

export default async function AdminRootPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: '/login', locale });
}
