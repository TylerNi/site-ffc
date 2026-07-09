'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/cart-client';
import { signIn } from '@/lib/account-client';

export interface SignInLabels {
  heading: string;
  intro: string;
  email: string;
  password: string;
  submit: string;
  submitting: string;
  error: string;
}

/** Connexion client (courriel + mot de passe) — préambule de « Mes commandes ». */
export function SignInForm({
  labels,
  onSignedIn,
}: {
  labels: SignInLabels;
  onSignedIn: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : labels.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-signin" onSubmit={submit} noValidate>
      <p>{labels.intro}</p>
      <label>
        <span>{labels.email}</span>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        <span>{labels.password}</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}
