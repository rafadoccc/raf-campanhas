import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

const field = 'mt-1 w-full rounded-lg border border-slate-300 p-2';

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

  return <main className="flex min-h-screen items-center justify-center p-6">
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
      <header><p className="text-sm font-semibold text-emerald-600">CENTRAL DE CAMPANHAS</p><h1 className="mt-2 text-2xl font-bold">Entrar</h1></header>
      {!hasUsers && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Nenhum usuário cadastrado ainda. Defina <code>ADMIN_EMAIL</code> e <code>ADMIN_PASSWORD</code> e reinicie o sistema, ou rode <code>npm run user:create</code>.</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <label className="block text-sm font-medium">E-mail<input name="email" type="email" required autoComplete="username" autoFocus className={field} /></label>
      <label className="block text-sm font-medium">Senha<input name="password" type="password" required autoComplete="current-password" className={field} /></label>
      <button disabled={busy} className="w-full rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? 'Entrando…' : 'Entrar'}</button>
    </form>
  </main>;
}
