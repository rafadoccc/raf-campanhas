import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePolling } from '../lib/use-polling';
import {
  Alert, Badge, Button, Card, CardHeader, Dot, EmptyState, Field, Page, PageHeader, ScrollArea, Select, Skeleton,
  IconAdd, IconAdmin, IconDisable, IconEnable, IconPassword, IconRemove,
  dataHora, inputClass, numero, useConfirm,
} from '../design';

const roleOptions = [{ value: 'USER', label: 'Usuário' }, { value: 'SUPER_ADMIN', label: 'Administrador' }];

type AdminUser = {
  id: string; email: string; name: string; role: 'SUPER_ADMIN' | 'USER'; disabledAt: string | null; createdAt: string; lastSeenAt: string | null;
  whatsapp: { state: string; accountJid: string | null; lastConnectedAt: string | null; lastError: string | null; legacySession: boolean };
  counts: { campaigns: number; activeCampaigns: number; groups: number; sent: number; failed: number };
};
const connectionLabel: Record<string, string> = { connected: 'Conectado', qr: 'Aguardando QR', connecting: 'Conectando', reconnecting: 'Reconectando', error: 'Com erro', disconnected: 'Desconectado' };

function CreateUser({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [role, setRole] = useState('USER');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await api('/admin/users', { method: 'POST', json: { name: form.get('name'), email: form.get('email'), password: form.get('password'), role } });
      onCreated(); onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <Card as="div" className="p-4">
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
      <Field label="Nome"><input name="name" required maxLength={120} className={inputClass} /></Field>
      <Field label="E-mail"><input name="email" type="email" required autoComplete="off" className={inputClass} /></Field>
      <Field label="Senha inicial" hint="10+ caracteres; a pessoa troca depois."><input name="password" type="password" required minLength={10} autoComplete="new-password" className={inputClass} /></Field>
      <Field label="Papel"><Select label="Papel" value={role} onChange={setRole} options={roleOptions} /></Field>
      <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy} disabled={busy}>Criar</Button><Button onClick={onClose}>Cancelar</Button></div>
      {error && <div className="sm:col-span-2 lg:col-span-5"><Alert>{error}</Alert></div>}
    </form>
  </Card>;
}

function UserRow({ user, self, onChanged }: { user: AdminUser; self: boolean; onChanged: () => void }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const disabled = Boolean(user.disabledAt);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); onChanged(); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  const toggle = () => run(async () => {
    const ok = await confirm(disabled
      ? { title: `Reativar ${user.name}?`, description: 'A pessoa volta a entrar. As campanhas continuam pausadas até ela retomar.', confirmLabel: 'Reativar' }
      : { title: `Desativar ${user.name}?`, description: 'A pessoa sai na hora, as campanhas ativas são pausadas e o WhatsApp é desligado sem perder a sessão (reativar volta a usar).', confirmLabel: 'Desativar', danger: true });
    if (ok) await api(`/admin/users/${user.id}`, { method: 'PATCH', json: { disabled: !disabled } });
  });
  const changeRole = () => run(async () => {
    const next = user.role === 'SUPER_ADMIN' ? 'USER' : 'SUPER_ADMIN';
    if (await confirm({ title: next === 'SUPER_ADMIN' ? `Tornar ${user.name} administrador?` : `Tirar o acesso de administrador de ${user.name}?`, description: next === 'SUPER_ADMIN' ? 'Administradores veem e gerenciam todas as contas (sem ver o conteúdo das campanhas).' : undefined, confirmLabel: 'Confirmar' })) {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', json: { role: next } });
    }
  });
  const resetPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    void run(async () => { await api(`/admin/users/${user.id}/password`, { method: 'POST', json: { password } }); setResetting(false); });
  };
  const wa = user.whatsapp;
  return <li className={`px-4 py-3 ${disabled ? 'bg-slate-50' : ''}`}>
    {/* Grade de colunas fixas: as contas ficam alinhadas mesmo sem os botões (linha "você"). */}
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_17rem_19rem] lg:items-center">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">{user.name}{self && <span className="text-2xs text-muted">(você)</span>}
          <Badge tone={user.role === 'SUPER_ADMIN' ? 'info' : 'neutral'}>{user.role === 'SUPER_ADMIN' ? 'Admin' : 'Usuário'}</Badge>
          {disabled && <Badge tone="danger">Desativado</Badge>}
        </p>
        <p className="truncate text-xs text-muted">{user.email} · último acesso {user.lastSeenAt ? dataHora(user.lastSeenAt) : 'nunca'}</p>
      </div>
      <div className="min-w-0 text-xs">
        <p className="flex items-center gap-1.5"><Dot tone={wa.state === 'connected' ? 'ok' : wa.state === 'error' ? 'warn' : ['qr', 'connecting', 'reconnecting'].includes(wa.state) ? 'busy' : 'off'} />{connectionLabel[wa.state] ?? wa.state}{wa.legacySession && <span className="text-2xs text-muted">(sessão antiga)</span>}</p>
        <p className="tabular text-muted">{wa.accountJid ? wa.accountJid.split('@')[0] : 'sem número'}</p>
        {wa.lastError && <p className="truncate text-2xs text-red-700" title={wa.lastError}>{wa.lastError}</p>}
      </div>
      <dl className="tabular grid grid-cols-5 gap-3 text-center text-xs">
        {([['Campanhas', user.counts.campaigns], ['Ativas', user.counts.activeCampaigns], ['Grupos', user.counts.groups], ['Enviados', user.counts.sent], ['Falhas', user.counts.failed]] as const).map(([label, value]) =>
          <div key={label}><dt className="text-2xs text-muted">{label}</dt><dd className={`font-semibold ${label === 'Falhas' && value ? 'text-red-700' : ''}`}>{numero(value)}</dd></div>)}
      </dl>
      {self ? <p className="text-2xs text-muted lg:text-right">Sua conta: altere em Minha conta.</p> : <div className="flex flex-wrap items-center gap-1 lg:justify-end">
        <Button size="sm" icon={IconPassword} disabled={busy} onClick={() => setResetting(v => !v)}>Senha</Button>
        <Button size="sm" icon={IconAdmin} disabled={busy} onClick={changeRole}>{user.role === 'SUPER_ADMIN' ? 'Tornar usuário' : 'Tornar admin'}</Button>
        <Button size="sm" variant={disabled ? 'secondary' : 'danger'} icon={disabled ? IconEnable : IconDisable} disabled={busy} onClick={toggle}>{disabled ? 'Reativar' : 'Desativar'}</Button>
      </div>}
    </div>
    {resetting && <form onSubmit={resetPassword} className="mt-2 flex flex-wrap items-center gap-2">
      <input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="Nova senha (10+ caracteres)" aria-label={`Nova senha para ${user.name}`} className={`${inputClass} !w-64`} />
      <Button type="submit" size="sm" variant="primary" loading={busy}>Salvar senha</Button>
      <Button size="sm" variant="ghost" icon={IconRemove} onClick={() => setResetting(false)}>Cancelar</Button>
      <span className="text-2xs text-muted">As sessões abertas dessa conta serão encerradas.</span>
    </form>}
    {error && <div className="mt-2"><Alert>{error}</Alert></div>}
  </li>;
}

export default function AdminPage() {
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data: users, error, reload } = usePolling(signal => api<AdminUser[]>('/admin/users', { signal }), [], 20_000);
  const active = users?.filter(u => !u.disabledAt) ?? [];
  return <Page className="lg:overflow-hidden">
    <PageHeader title="Administração" subtitle={users ? `${users.length} contas · ${active.length} ativas · ${users.filter(u => u.whatsapp.state === 'connected').length} WhatsApp conectados` : 'Contas do sistema'}
      action={!creating && <Button variant="primary" icon={IconAdd} onClick={() => setCreating(true)}>Nova conta</Button>} />
    {creating && <CreateUser onCreated={reload} onClose={() => setCreating(false)} />}
    {error && !users && <Alert tone="warning">Não foi possível carregar as contas.</Alert>}
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader title="Contas" action={<span className="text-2xs text-muted">O conteúdo das campanhas de cada conta não aparece aqui.</span>} />
      <ScrollArea className="flex-1">
        {!users ? <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : users.length === 0 ? <EmptyState title="Nenhuma conta." />
          : <ul className="divide-y divide-line">{users.map(u => <UserRow key={u.id} user={u} self={u.id === me?.id} onChanged={reload} />)}</ul>}
      </ScrollArea>
    </Card>
  </Page>;
}
