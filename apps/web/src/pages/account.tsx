import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Button, Card, Field, Page, PageHeader, IconPassword, inputClass } from '../design';

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

  return <Page>
    <div className="mx-auto w-full max-w-md space-y-4">
      <PageHeader title={user?.name ?? 'Minha conta'} subtitle={<span className="inline-flex items-center gap-2">{user?.email}<Badge tone={user?.role === 'SUPER_ADMIN' ? 'info' : 'neutral'}>{user?.role === 'SUPER_ADMIN' ? 'Administrador' : 'Usuário'}</Badge></span>} />
      <Card as="div" className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <h2 className="text-sm font-semibold">Trocar senha</h2>
          {notice && <Alert tone="brand">{notice}</Alert>}
          {error && <Alert>{error}</Alert>}
          <Field label="Senha atual"><input name="current" type="password" required autoComplete="current-password" className={inputClass} /></Field>
          <Field label="Nova senha" hint="Mínimo de 10 caracteres."><input name="next" type="password" required minLength={10} autoComplete="new-password" className={inputClass} /></Field>
          <Field label="Repita a nova senha"><input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={inputClass} /></Field>
          <Button type="submit" variant="primary" icon={IconPassword} loading={busy} disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</Button>
        </form>
      </Card>
    </div>
  </Page>;
}
