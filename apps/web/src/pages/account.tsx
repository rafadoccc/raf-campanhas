import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PlanCard } from '../components/plan-notice';
import { Alert, Badge, Button, Card, Field, Page, PageHeader, PasswordInput, IconDelete, IconDownload, IconPassword, buttonClass, useConfirm } from '../design';

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
function PrivacyCard() {
  const { user, accountDeleted } = useAuth();
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const admin = user?.role === 'SUPER_ADMIN';

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    setError('');
    const ok = await confirm({
      title: 'Excluir sua conta para sempre?',
      description: 'Campanhas, mensagens, mídias, grupos e a conexão do WhatsApp são apagados na hora. Não dá para desfazer.',
      confirmLabel: 'Excluir minha conta', danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api('/account/delete', { method: 'POST', json: { password } });
      accountDeleted();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  return <Card as="div" className="space-y-4 p-5">
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">Seus dados</h2>
      <p className="text-xs text-muted">
        Campanhas encerradas são apagadas sozinhas depois de 6 meses.
        Veja a <Link className="text-brand-700 underline" to="/privacidade">Política de Privacidade</Link> e os <Link className="text-brand-700 underline" to="/termos">Termos de Uso</Link>.
      </p>
    </div>
    <div>
      {/* Link direto: o servidor responde como download (arquivo JSON). */}
      <a href="/api/account/export" download className={buttonClass('secondary')}><IconDownload className="h-4 w-4" aria-hidden />Baixar meus dados</a>
      <p className="mt-1 text-2xs text-slate-400">Arquivo com a conta, os acessos, os grupos e as campanhas.</p>
    </div>
    <div className="border-t border-line pt-4">
      {admin
        ? <p className="text-xs text-muted">Contas de administrador não podem ser excluídas. Para excluir esta conta, passe o papel de administrador para outra pessoa antes.</p>
        : !deleting
          ? <Button variant="danger" icon={IconDelete} onClick={() => setDeleting(true)}>Excluir minha conta</Button>
          : <form onSubmit={event => void remove(event)} className="space-y-3">
            <Alert tone="warning">Tudo será apagado: campanhas, mensagens, mídias, grupos e a conexão do WhatsApp. Se o WhatsApp não estiver conectado agora, remova o aparelho do sistema também no celular (WhatsApp → Aparelhos conectados).</Alert>
            {error && <Alert>{error}</Alert>}
            <Field label="Digite sua senha para confirmar"><PasswordInput name="password" required autoComplete="current-password" /></Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" icon={IconDelete} loading={busy} disabled={busy}>Excluir para sempre</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setDeleting(false); setError(''); }}>Cancelar</Button>
            </div>
          </form>}
    </div>
  </Card>;
}
