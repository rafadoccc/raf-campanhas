import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

const field = 'mt-1 w-full rounded-lg border border-slate-300 p-2';

export default function AccountPage() {
  const { user } = useAuth();
  const [notice, setNotice] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setNotice(''); setError('');
    if (form.get('next') !== form.get('confirm')) { setError('A confirmação não confere com a nova senha.'); return; }
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', json: { current: form.get('current'), next: form.get('next') } });
      formElement.reset();
      setNotice('Senha alterada. As outras sessões abertas foram encerradas.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-xl space-y-6 p-8">
    <header><p className="text-sm font-semibold text-emerald-700">CONTA</p><h1 className="mt-2 text-3xl font-bold">{user?.name}</h1><p className="mt-1 text-slate-500">{user?.email}</p></header>
    <form onSubmit={submit} className="space-y-4 rounded-xl border bg-white p-6">
      <h2 className="text-xl font-semibold">Trocar senha</h2>
      {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <label className="block text-sm font-medium">Senha atual<input name="current" type="password" required autoComplete="current-password" className={field} /></label>
      <label className="block text-sm font-medium">Nova senha (mínimo 10 caracteres)<input name="next" type="password" required minLength={10} autoComplete="new-password" className={field} /></label>
      <label className="block text-sm font-medium">Repita a nova senha<input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={field} /></label>
      <button disabled={busy} className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
    </form>
  </main>;
}
