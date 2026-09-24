import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePolling } from '../lib/use-polling';
import {
  Alert, Badge, Button, Card, CardHeader, Dot, EmptyState, Field, Page, PageHeader, ScrollArea, Select, Skeleton, Stat,
  IconAdd, IconAdmin, IconCampaigns, IconDelivered, IconDisable, IconDisconnect, IconDispatcher, IconEnable,
  IconLogout, IconPassword, IconQueue, IconRemove, IconSearch, IconSent, IconSystem, IconWhatsApp,
  dataHora, inputClass, numero, useConfirm,
} from '../design';

const roleOptions = [{ value: 'USER', label: 'Usuário' }, { value: 'SUPER_ADMIN', label: 'Administrador' }];
const statusFilters = [{ label: 'Todas', value: 'all' }, { label: 'Ativas', value: 'active' }, { label: 'Desativadas', value: 'disabled' }] as const;
const roleFilters = [{ label: 'Todos', value: 'all' }, { label: 'Usuários', value: 'USER' }, { label: 'Admins', value: 'SUPER_ADMIN' }] as const;

type AdminUser = {
  id: string; email: string; name: string; role: 'SUPER_ADMIN' | 'USER'; disabledAt: string | null; createdAt: string; lastSeenAt: string | null;
  whatsapp: { state: string; accountJid: string | null; lastConnectedAt: string | null; lastError: string | null; legacySession: boolean };
  counts: { campaigns: number; activeCampaigns: number; groups: number; sent: number; failed: number };
};
type Overview = {
  serverNow: string;
  users: { total: number; active: number; disabled: number; admins: number };
  campaigns: { total: number; active: number; paused: number; draft: number; completed: number; cancelled: number };
  today: { sent: number; failed: number; delivered: number; deliveryRate: number | null; successRate: number | null };
  queueNow: number;
  last7Days: { day: string; sent: number; failed: number }[];
  topErrorCodes: { code: string; count: number }[];
  whatsapp: { connectedNow: number; paired: number };
  dispatcher: { ownerId: string | null; active: boolean; expiresAt: string | null };
  process: { uptimeSeconds: number; memoryMb: { rss: number; heapUsed: number } };
};
const connectionLabel: Record<string, string> = { connected: 'Conectado', qr: 'Aguardando QR', connecting: 'Conectando', reconnecting: 'Reconectando', error: 'Com erro', disconnected: 'Desconectado' };
const weekday = (iso: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)).replace('.', '');
const uptime = (seconds: number) => { const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60); return h ? `${h}h${m}min` : `${m}min`; };

function WeekBars({ days }: { days: Overview['last7Days'] }) {
  const max = Math.max(1, ...days.map(d => d.sent + d.failed));
  return <div className="flex h-full items-end gap-1.5" role="img" aria-label={`Envios dos últimos 7 dias: ${days.map(d => `${d.sent} enviados, ${d.failed} falhas`).join('; ')}`}>
    {days.map((d, i) => <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${weekday(d.day)}: ${d.sent} enviados, ${d.failed} falhas`}>
      <span className="tabular text-2xs text-muted">{d.sent + d.failed || ''}</span>
      <div className="flex w-full flex-col-reverse overflow-hidden rounded-sm" style={{ height: '72px' }}>
        <div className={`w-full ${i === days.length - 1 ? 'bg-brand-600' : 'bg-brand-100'}`} style={{ height: `${Math.max(d.sent ? 3 : 0, (d.sent / max) * 72)}px` }} />
        {d.failed > 0 && <div className="w-full bg-red-400" style={{ height: `${Math.max(3, (d.failed / max) * 72)}px` }} />}
      </div>
      <span className="text-2xs capitalize text-slate-400">{weekday(d.day)}</span>
    </div>)}
  </div>;
}

function OverviewPanel({ overview }: { overview: Overview | null }) {
  const o = overview;
  const metric = (value: number | undefined, suffix = '') => (o ? `${numero(value ?? 0)}${suffix}` : '—');
  return <>
    <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat icon={IconAdmin} label="Contas" value={metric(o?.users.total)} hint={o ? `${o.users.active} ativas · ${o.users.admins} admin` : undefined} />
      <Stat icon={IconCampaigns} label="Campanhas ativas" value={metric(o?.campaigns.active)} hint={o ? `${o.campaigns.total} no total` : undefined} />
      <Stat icon={IconSent} label="Enviados hoje" value={metric(o?.today.sent)} hint={o?.today.failed ? `${o.today.failed} com falha` : 'sem falhas'} />
      <Stat icon={IconDelivered} label="Entregues hoje" value={metric(o?.today.delivered)} hint={o?.today.deliveryRate == null ? 'sem envios hoje' : `${o.today.deliveryRate}% dos enviados`} tone="text-brand-700" />
      <Stat icon={IconQueue} label="Na fila" value={metric(o?.queueNow)} hint="envios aguardando" />
      <Stat icon={IconWhatsApp} label="WhatsApp conectados" value={metric(o?.whatsapp.connectedNow)} hint={o ? `${o.whatsapp.paired} pareados` : undefined} />
    </Card>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="p-4 sm:col-span-2 lg:col-span-2">
        <p className="text-xs text-muted">Envios nos últimos 7 dias</p>
        <div className="mt-2 h-24">{o ? <WeekBars days={o.last7Days} /> : <Skeleton className="h-full" />}</div>
      </Card>
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted"><IconDispatcher className="h-3.5 w-3.5" aria-hidden />Despachante</p>
        {!o ? <Skeleton className="mt-2 h-12" /> : <>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold"><Dot tone={o.dispatcher.active ? 'ok' : 'off'} />{o.dispatcher.active ? 'Ativo' : 'Parado'}</p>
          <p className="mt-1 text-2xs text-muted">{o.dispatcher.expiresAt ? `Posse expira ${dataHora(o.dispatcher.expiresAt)}` : 'Sem posse registrada'}</p>
        </>}
      </Card>
      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted"><IconSystem className="h-3.5 w-3.5" aria-hidden />Processo</p>
        {!o ? <Skeleton className="mt-2 h-12" /> : <>
          <p className="mt-1 text-sm font-semibold">{uptime(o.process.uptimeSeconds)} no ar</p>
          <p className="mt-1 text-2xs text-muted">{o.process.memoryMb.rss} MB em uso (heap {o.process.memoryMb.heapUsed} MB)</p>
        </>}
      </Card>
    </div>
    {o && o.topErrorCodes.length > 0 && <Card className="p-4">
      <p className="text-xs text-muted">Erros mais comuns nos últimos 7 dias</p>
      <div className="mt-2 flex flex-wrap gap-2">{o.topErrorCodes.map(e => <Badge key={e.code} tone="danger">{e.code} · {e.count}</Badge>)}</div>
    </Card>}
  </>;
}

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
  const forceLogout = () => run(async () => {
    if (await confirm({ title: `Encerrar as sessões de ${user.name}?`, description: 'A pessoa é desconectada de onde estiver logada. Nada muda nas campanhas nem no WhatsApp.', confirmLabel: 'Encerrar sessões' })) {
      await api(`/admin/users/${user.id}/logout`, { method: 'POST', json: {} });
    }
  });
  const stopWhatsApp = () => run(async () => {
    if (await confirm({ title: `Desconectar o WhatsApp de ${user.name}?`, description: 'A conexão cai sem perder a autenticação (a pessoa reconecta sem escanear o QR de novo). As campanhas continuam ativas, só esperando a conexão voltar.', confirmLabel: 'Desconectar' })) {
      await api(`/admin/users/${user.id}/whatsapp/stop`, { method: 'POST', json: {} });
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
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_17rem_23rem] lg:items-center">
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
        <Button size="sm" icon={IconLogout} disabled={busy} onClick={forceLogout} title="Encerrar as sessões abertas desta conta">Sair</Button>
        {wa.state === 'connected' && <Button size="sm" icon={IconDisconnect} disabled={busy} onClick={stopWhatsApp} title="Desconectar o WhatsApp, preservando a autenticação">Desconectar</Button>}
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

// Sem acento e sem diferenciar maiúsculas: "joao" encontra "João".
const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export default function AdminPage() {
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<typeof statusFilters[number]['value']>('all');
  const [role, setRole] = useState<typeof roleFilters[number]['value']>('all');
  const { data, error, reload } = usePolling(async signal => {
    const [overview, users] = await Promise.all([api<Overview>('/admin/overview', { signal }), api<AdminUser[]>('/admin/users', { signal })]);
    return { overview, users };
  }, [], 20_000);
  const users = data?.users ?? null;
  const term = normalize(search);
  const visible = (users ?? []).filter(u =>
    (status === 'all' || (status === 'active') === !u.disabledAt) &&
    (role === 'all' || u.role === role) &&
    (!term || normalize(u.name).includes(term) || normalize(u.email).includes(term)));

  return <Page className="lg:overflow-hidden">
    <PageHeader title="Administração" subtitle="Métricas do sistema inteiro e gestão de contas — nunca o conteúdo das campanhas."
      action={!creating && <Button variant="primary" icon={IconAdd} onClick={() => setCreating(true)}>Nova conta</Button>} />
    {error && !data && <Alert tone="warning">Não foi possível carregar o painel.</Alert>}
    <OverviewPanel overview={data?.overview ?? null} />
    {creating && <CreateUser onCreated={reload} onClose={() => setCreating(false)} />}
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader title="Contas" action={<span className="text-2xs text-muted">{users ? `${visible.length} de ${users.length}` : ''}</span>} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="relative min-w-[10rem] flex-1">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nome ou e-mail…" aria-label="Buscar conta" className={`${inputClass} pl-8`} />
        </div>
        <div className="flex rounded border border-line bg-white p-0.5">
          {statusFilters.map(f => <button key={f.value} type="button" onClick={() => setStatus(f.value)} className={`h-7 rounded-sm px-2.5 text-xs ${status === f.value ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:text-ink'}`}>{f.label}</button>)}
        </div>
        <div className="flex rounded border border-line bg-white p-0.5">
          {roleFilters.map(f => <button key={f.value} type="button" onClick={() => setRole(f.value)} className={`h-7 rounded-sm px-2.5 text-xs ${role === f.value ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:text-ink'}`}>{f.label}</button>)}
        </div>
      </div>
      <ScrollArea className="flex-1">
        {!users ? <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : visible.length === 0 ? <EmptyState title={term || status !== 'all' || role !== 'all' ? 'Nenhuma conta com esse filtro.' : 'Nenhuma conta.'} />
          : <ul className="divide-y divide-line">{visible.map(u => <UserRow key={u.id} user={u} self={u.id === me?.id} onChanged={reload} />)}</ul>}
      </ScrollArea>
    </Card>
  </Page>;
}
