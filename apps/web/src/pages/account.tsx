import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PlanCard } from '../components/plan-notice';
import { Alert, Badge, Button, Card, Field, Page, PageHeader, PasswordInput, IconDelete, IconDownload, IconPassword, buttonClass } from '../design';

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
      <PlanCard />
      <Card as="div" className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <h2 className="text-sm font-semibold">Trocar senha</h2>
          {notice && <Alert tone="brand">{notice}</Alert>}
          {error && <Alert>{error}</Alert>}
          <Field label="Senha atual"><PasswordInput name="current" required autoComplete="current-password" /></Field>
          <Field label="Nova senha" hint="Mínimo de 10 caracteres."><PasswordInput name="next" required minLength={10} autoComplete="new-password" /></Field>
          <Field label="Repita a nova senha"><PasswordInput name="confirm" required minLength={10} autoComplete="new-password" /></Field>
          <Button type="submit" variant="primary" icon={IconPassword} loading={busy} disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</Button>
        </form>
      </Card>
      <PrivacyCard />
    </div>
  </Page>;
}

// Direitos do titular (LGPD, ADR-040): baixar tudo o que o sistema guarda e excluir a conta.
// A senha já é a confirmação da exclusão (o servidor confere): sem segunda janela de "tem certeza?".
function PrivacyCard() {
  const { user, accountDeleted } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const admin = user?.role === 'SUPER_ADMIN';

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    setBusy(true); setError('');
    try {
      await api('/account/delete', { method: 'POST', json: { password } });
      accountDeleted();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  return <Card as="div" className="space-y-3 p-5">
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">Seus dados</h2>
      <p className="text-xs text-muted">
        Veja a <Link className="text-brand-700 underline" to="/privacidade">Política de Privacidade</Link> e os <Link className="text-brand-700 underline" to="/termos">Termos de Uso</Link>.
      </p>
    </div>
    {!deleting && <div className="flex flex-wrap items-center gap-2">
      {/* Link direto: o servidor responde como download (arquivo JSON). */}
      <a href="/api/account/export" download className={buttonClass('secondary', 'sm')}><IconDownload className="h-4 w-4" aria-hidden />Baixar meus dados</a>
      {!admin && <Button variant="ghost" size="sm" icon={IconDelete} className="text-red-700 hover:bg-red-50" onClick={() => setDeleting(true)}>Excluir minha conta</Button>}
    </div>}
    {admin && <p className="text-2xs text-slate-400">Conta de administrador não é excluída por aqui: passe o papel para outra pessoa antes.</p>}
    {deleting && <form onSubmit={event => void remove(event)} className="animate-fade-in space-y-3">
      <p className="text-xs text-red-800">Apaga na hora a conta, as campanhas, as mídias, os grupos e a conexão do WhatsApp. Não dá para desfazer.</p>
      {error && <Alert>{error}</Alert>}
      <Field label="Sua senha, para confirmar"><PasswordInput name="password" required autoFocus autoComplete="current-password" /></Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" size="sm" icon={IconDelete} loading={busy} disabled={busy}>Excluir para sempre</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDeleting(false); setError(''); }}>Cancelar</Button>
      </div>
    </form>}
  </Card>;
}
