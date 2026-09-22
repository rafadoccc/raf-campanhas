import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { card, page, primaryButton } from '../components/ui';

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

  return <main className={`${page} max-w-xl space-y-6`}>
    <header><h1 className="text-2xl font-bold">{user?.name}</h1><p className="text-sm text-slate-500">{user?.email}</p></header>
    <form onSubmit={submit} className={`${card} space-y-4 p-6`}>
      <h2 className="font-semibold">Trocar senha</h2>
      {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <label className="block text-sm font-medium">Senha atual<input name="current" type="password" required autoComplete="current-password" className={field} /></label>
      <label className="block text-sm font-medium">Nova senha (mínimo 10 caracteres)<input name="next" type="password" required minLength={10} autoComplete="new-password" className={field} /></label>
      <label className="block text-sm font-medium">Repita a nova senha<input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={field} /></label>
      <button disabled={busy} className={primaryButton}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
    </form>
  </main>;
}
