import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Field, inputClass } from '../design';

export default function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasUsers, setHasUsers] = useState(true);
  useEffect(() => { api<{ hasUsers: boolean }>('/auth/setup').then(r => setHasUsers(r.hasUsers)).catch(() => undefined); }, []);
  if (user) return <Navigate to={from} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await signIn(String(form.get('email')), String(form.get('password')));
      navigate(from, { replace: true });
    } catch (e) { setError(errorMessage(e, 'Não foi possível entrar.')); }
    finally { setBusy(false); }
  }

  return <main className="flex min-h-full items-center justify-center p-6">
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-white p-6 shadow-card">
      <header className="flex items-center gap-2">
        <span aria-hidden className="grid h-7 w-7 place-items-center rounded bg-brand-600 text-2xs font-bold text-white">CC</span>
        <div><p className="text-2xs font-medium uppercase tracking-wide text-muted">Central de Campanhas</p><h1 className="text-lg font-semibold leading-tight">Entrar</h1></div>
      </header>
      {!hasUsers && <Alert tone="warning">Nenhum usuário cadastrado ainda. Defina <code>ADMIN_EMAIL</code> e <code>ADMIN_PASSWORD</code> e reinicie o sistema, ou rode <code>npm run user:create</code>.</Alert>}
      {error && <Alert>{error}</Alert>}
      <Field label="E-mail"><input name="email" type="email" required autoComplete="username" autoFocus className={inputClass} /></Field>
      <Field label="Senha"><input name="password" type="password" required autoComplete="current-password" className={inputClass} /></Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</Button>
    </form>
  </main>;
}
