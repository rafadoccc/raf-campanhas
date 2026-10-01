import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { Alert, Button, Field, Logo, PasswordInput, inputClass } from '../design';

// "Esqueci minha senha" (ADR-047), sem login. Duas telas: pedir o link (/esqueci-senha) e criar a
// senha nova por ele (/redefinir-senha/:codigo). A primeira responde sempre igual, exista a conta
// ou não; só muda o aviso conforme o sistema manda o link por e-mail ou pelo administrador.

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return <main className="flex min-h-full items-center justify-center p-6">
    <div className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-white p-6 shadow-card">
      <header>
        <Logo className="text-2xl" />
        <h1 className="mt-3 text-sm font-medium leading-tight text-muted">{title}</h1>
      </header>
      {children}
      <p className="text-center text-2xs text-muted"><Link className="hover:text-ink hover:underline" to="/login">Voltar para a entrada</Link></p>
    </div>
  </main>;
}

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [delivery, setDelivery] = useState<'email' | 'admin' | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await api<{ delivery: 'email' | 'admin' }>('/auth/forgot', { method: 'POST', json: { email: new FormData(event.currentTarget).get('email') } });
      setDelivery(result.delivery);
    } catch (e) { setError(errorMessage(e, 'Não foi possível registrar o pedido.')); }
    finally { setBusy(false); }
  }
  return <Shell title="Criar uma nova senha">
    {delivery
      ? <Alert tone="brand">{delivery === 'email'
        ? 'Se existir uma conta com esse e-mail, enviamos um link para criar a nova senha. Ele vale por 1 hora; confira também a caixa de spam.'
        : 'Pedido registrado. Se existir uma conta com esse e-mail, quem administra o sistema vai te enviar um link para criar a nova senha.'}</Alert>
      : <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Informe o e-mail da sua conta. Você recebe um link para criar uma senha nova; a senha atual continua valendo até lá.</p>
        {error && <Alert>{error}</Alert>}
        <Field label="E-mail"><input name="email" type="email" required autoComplete="username" autoFocus className={inputClass} /></Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={busy}>Pedir o link</Button>
      </form>}
  </Shell>;
}

export function ResetPasswordPage() {
  const token = useParams().token ?? '';
  const [state, setState] = useState<'checking' | 'ready' | 'invalid' | 'done'>('checking');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    api<{ name: string }>(`/auth/reset/${encodeURIComponent(token)}`)
      .then(result => { setName(result.name); setState('ready'); })
      .catch(() => setState('invalid'));
  }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    if (form.get('password') !== form.get('confirm')) { setError('A confirmação não confere com a nova senha.'); return; }
    setBusy(true);
    try {
      await api(`/auth/reset/${encodeURIComponent(token)}`, { method: 'POST', json: { password: form.get('password') } });
      setState('done');
    } catch (e) { setError(errorMessage(e, 'Não foi possível salvar a nova senha.')); }
    finally { setBusy(false); }
  }
  return <Shell title={state === 'ready' && name ? `Nova senha para ${name}` : 'Criar uma nova senha'}>
    {state === 'checking' && <p className="text-sm text-muted">Conferindo o link…</p>}
    {state === 'invalid' && <>
      <Alert tone="warning">Este link não vale mais: já foi usado ou venceu.</Alert>
      <Link to="/esqueci-senha" className="block text-center text-sm font-medium underline">Pedir um novo link</Link>
    </>}
    {state === 'done' && <>
      <Alert tone="brand">Senha criada. As sessões que estavam abertas foram encerradas.</Alert>
      <Link to="/login" className="block text-center text-sm font-medium underline">Entrar com a nova senha</Link>
    </>}
    {state === 'ready' && <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Field label="Nova senha" hint="Mínimo de 10 caracteres."><PasswordInput name="password" required minLength={10} autoComplete="new-password" autoFocus /></Field>
      <Field label="Repita a nova senha"><PasswordInput name="confirm" required minLength={10} autoComplete="new-password" /></Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={busy}>Salvar nova senha</Button>
    </form>}
  </Shell>;
}
