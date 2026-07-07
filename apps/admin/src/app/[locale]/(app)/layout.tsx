import { type ReactNode } from 'react';
import { AdminShell } from '@/components/AdminShell';

/** Enveloppe authentifiée : navigation, garde de session, inactivité. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
