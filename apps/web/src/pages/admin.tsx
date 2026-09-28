import { useState, type FormEvent, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePolling } from '../lib/use-polling';
import {
  Alert, Badge, Button, ButtonLink, Card, CardHeader, Dot, EmptyState, Field, Menu, Page, PageHeader, PasswordInput, Segmented, Select, Skeleton, Stat,
  IconActivity, IconAddUser, IconAdmin, IconCampaigns, IconDelivered, IconDisable, IconDisconnect, IconDispatcher, IconEnable,
  IconLogout, IconPassword, IconQueue, IconSearch, IconSent, IconServer, IconSystem, IconWhatsApp,
  dataHora, horaSeg, inputClass, numero, useConfirm, type MenuItem,
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
const connectionTone = (state: string) => state === 'connected' ? 'ok' : state === 'error' ? 'warn' : ['qr', 'connecting', 'reconnecting'].includes(state) ? 'busy' : 'off';
const weekday = (iso: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)).replace('.', '');
const uptime = (seconds: number) => {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
};
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?';
const plural = (n: number, one: string, many: string) => `${numero(n)} ${n === 1 ? one : many}`;
const paired = (n: number) => n === 0 ? 'nenhum número pareado' : plural(n, 'número pareado', 'números pareados');
// Sem acento e sem diferenciar maiúsculas: "joao" encontra "João".
const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ─── Visão geral ────────────────────────────────────────────────────────────────

function Summary({ overview: o }: { overview: Overview | null }) {
  const metric = (value: number | undefined) => (o ? numero(value ?? 0) : '—');
  return <Card>
    <CardHeader title="Visão geral" action={o && <span className="text-2xs text-muted">Atualizado às {horaSeg(o.serverNow)}</span>} />
    <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat icon={IconAdmin} label="Contas" value={metric(o?.users.total)} hint={o ? `${o.users.active} ativas · ${plural(o.users.admins, 'admin', 'admins')}` : undefined} />
      <Stat icon={IconWhatsApp} label="WhatsApp conectados" value={metric(o?.whatsapp.connectedNow)} hint={o ? (o.whatsapp.paired ? `de ${paired(o.whatsapp.paired)}` : paired(0)) : undefined} />
      <Stat icon={IconCampaigns} label="Campanhas ativas" value={metric(o?.campaigns.active)} hint={o ? `${numero(o.campaigns.total)} no total` : undefined} />
      <Stat icon={IconQueue} label="Na fila" value={metric(o?.queueNow)} hint="envios aguardando" />
      <Stat icon={IconSent} label="Enviados hoje" value={metric(o?.today.sent)} hint={o?.today.failed ? `${plural(o.today.failed, 'falha', 'falhas')}` : 'sem falhas'} />
      <Stat icon={IconDelivered} label="Entregues hoje" value={metric(o?.today.delivered)} hint={o?.today.deliveryRate == null ? 'sem envios hoje' : `${o.today.deliveryRate}% dos enviados`} tone="text-brand-700" />
    </div>
  </Card>;
}

function WeekBars({ days }: { days: Overview['last7Days'] }) {
  const max = Math.max(1, ...days.map(d => d.sent + d.failed));
  return <div className="flex h-full items-end gap-2" role="img" aria-label={`Envios dos últimos 7 dias: ${days.map(d => `${weekday(d.day)}, ${d.sent} enviados e ${d.failed} falhas`).join('; ')}`}>
    {days.map((d, i) => <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${weekday(d.day)}: ${d.sent} enviados, ${d.failed} falhas`}>
      <span className="tabular text-2xs text-muted">{d.sent + d.failed || ''}</span>
      <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm border-b border-line" style={{ height: '96px' }}>
        <div className={`w-full ${i === days.length - 1 ? 'bg-brand-600' : 'bg-brand-500/60'}`} style={{ height: `${Math.max(d.sent ? 3 : 0, (d.sent / max) * 96)}px` }} />
        {d.failed > 0 && <div className="w-full bg-red-400" style={{ height: `${Math.max(3, (d.failed / max) * 96)}px` }} />}
      </div>
      <span className={`text-2xs capitalize ${i === days.length - 1 ? 'font-semibold text-ink' : 'text-slate-400'}`}>{i === days.length - 1 ? 'hoje' : weekday(d.day)}</span>
    </div>)}
  </div>;
}

function Activity({ overview: o }: { overview: Overview | null }) {
  const legend = <span className="flex items-center gap-3 text-2xs text-muted">
    <span className="flex items-center gap-1"><span aria-hidden className="h-2 w-2 rounded-sm bg-brand-600" />Enviados</span>
    <span className="flex items-center gap-1"><span aria-hidden className="h-2 w-2 rounded-sm bg-red-400" />Falhas</span>
  </span>;
  return <Card className="flex min-w-0 flex-col lg:col-span-2">
    <CardHeader title={<span className="flex items-center gap-1.5"><IconActivity className="h-4 w-4 text-muted" aria-hidden />Envios nos últimos 7 dias</span>} action={legend} />
    <div className="h-36 p-4">{o ? <WeekBars days={o.last7Days} /> : <Skeleton className="h-full" />}</div>
    <div className="mt-auto border-t border-line px-4 py-3">
      <p className="text-xs font-medium text-muted">Erros mais comuns nos últimos 7 dias</p>
      {!o ? <Skeleton className="mt-2 h-5 w-48" />
        : o.topErrorCodes.length === 0 ? <p className="mt-1 text-xs text-slate-400">Nenhum erro registrado.</p>
          : <div className="mt-2 flex flex-wrap gap-1.5">{o.topErrorCodes.map(e => <Badge key={e.code} tone="danger">{e.code} · {e.count}</Badge>)}</div>}
    </div>
  </Card>;
}

function HealthRow({ icon: Icon, label, children, detail }: { icon: typeof IconServer; label: string; children: ReactNode; detail?: ReactNode }) {
  return <li className="flex items-start justify-between gap-3 px-4 py-3">
    <span className="flex items-center gap-2 text-xs text-muted"><Icon className="h-4 w-4" aria-hidden />{label}</span>
    <span className="min-w-0 text-right">
      <span className="flex items-center justify-end gap-1.5 text-sm font-medium">{children}</span>
      {detail && <span className="block text-2xs text-slate-400">{detail}</span>}
    </span>
  </li>;
}

function Health({ overview: o }: { overview: Overview | null }) {
  return <Card className="min-w-0">
    <CardHeader title={<span className="flex items-center gap-1.5"><IconServer className="h-4 w-4 text-muted" aria-hidden />Saúde do sistema</span>} />
    {!o ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
      : <ul className="divide-y divide-line">
        <HealthRow icon={IconDispatcher} label="Fila de envios" detail={o.dispatcher.active ? 'confere a fila a cada 5 s' : 'reinicie o sistema se continuar assim'}>
          <Dot tone={o.dispatcher.active ? 'ok' : 'warn'} />{o.dispatcher.active ? 'Funcionando' : 'Parada'}
        </HealthRow>
        <HealthRow icon={IconCampaigns} label="Outras campanhas" detail={plural(o.campaigns.completed + o.campaigns.cancelled, 'encerrada', 'encerradas')}>
          {plural(o.campaigns.paused, 'pausada', 'pausadas')} · {plural(o.campaigns.draft, 'rascunho', 'rascunhos')}
        </HealthRow>
        <HealthRow icon={IconSystem} label="Servidor" detail={`${o.process.memoryMb.rss} MB de memória`}>
          no ar há {uptime(o.process.uptimeSeconds)}
        </HealthRow>
      </ul>}
  </Card>;
}

// ─── Contas ─────────────────────────────────────────────────────────────────────

function CreateUser({ onCreated, onClose }: { onCreated: (email: string) => void; onClose: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [role, setRole] = useState('USER');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await api('/admin/users', { method: 'POST', json: { name: form.get('name'), email: form.get('email'), password: form.get('password'), role } });
      onCreated(String(form.get('email')));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="border-b border-line bg-slate-50 px-4 py-4">
    <p className="text-sm font-semibold">Nova conta</p>
    <p className="mt-0.5 text-xs text-muted">A pessoa entra com este e-mail e esta senha inicial, e pode trocar a senha em Minha conta.</p>
    <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Nome"><input name="name" required maxLength={120} autoFocus className={inputClass} /></Field>
      <Field label="E-mail"><input name="email" type="email" required autoComplete="off" className={inputClass} /></Field>
      <Field label="Senha inicial" hint="Pelo menos 10 caracteres."><PasswordInput name="password" required minLength={10} autoComplete="new-password" /></Field>
      <Field label="Papel" hint={role === 'SUPER_ADMIN' ? 'Vê e gerencia todas as contas.' : 'Vê só as próprias campanhas.'}><Select label="Papel" value={role} onChange={setRole} options={roleOptions} /></Field>
    </div>
    {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    <div className="mt-3 flex justify-end gap-2">
      <Button onClick={onClose} disabled={busy}>Cancelar</Button>
      <Button type="submit" variant="primary" icon={IconAddUser} loading={busy} disabled={busy}>Criar conta</Button>
    </div>
  </form>;
}

function UserRow({ user, self, onChanged }: { user: AdminUser; self: boolean; onChanged: () => void }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState('');
  const disabled = Boolean(user.disabledAt);
  const wa = user.whatsapp;
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
    void run(async () => {
      await api(`/admin/users/${user.id}/password`, { method: 'POST', json: { password } });
      setResetting(false);
      setNotice(`Senha de ${user.name} alterada. A pessoa entra de novo com a senha nova.`);
    });
  };
  const actions: MenuItem[] = [
    { label: 'Encerrar sessões', icon: IconLogout, onSelect: () => void forceLogout() },
    ...(wa.state === 'connected' ? [{ label: 'Desconectar WhatsApp', icon: IconDisconnect, onSelect: () => void stopWhatsApp() }] : []),
    { label: user.role === 'SUPER_ADMIN' ? 'Tornar usuário' : 'Tornar administrador', icon: IconAdmin, onSelect: () => void changeRole() },
    disabled
      ? { label: 'Reativar conta', icon: IconEnable, onSelect: () => void toggle() }
      : { label: 'Desativar conta', icon: IconDisable, danger: true, onSelect: () => void toggle() },
  ];
  const counts = [['Campanhas', user.counts.campaigns, user.counts.activeCampaigns ? plural(user.counts.activeCampaigns, 'ativa', 'ativas') : ''], ['Grupos', user.counts.groups, ''], ['Enviados', user.counts.sent, ''], ['Falhas', user.counts.failed, '']] as const;

  return <li className={`px-4 py-3 ${disabled ? 'bg-slate-50/70' : ''}`}>
    <div className={`${rowGrid} items-center`}>
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-md text-xs font-semibold ${disabled ? 'bg-slate-100 text-slate-400' : 'bg-brand-50 text-brand-700'}`}>{initials(user.name)}</span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            <span className={`truncate ${disabled ? 'text-muted' : ''}`}>{user.name}</span>
            {self && <Badge tone="brand">Você</Badge>}
            {user.role === 'SUPER_ADMIN' && <Badge tone="info">Admin</Badge>}
            {disabled && <Badge tone="danger">Desativada</Badge>}
          </p>
          <p className="truncate text-xs text-muted" title={user.email}>{user.email}</p>
          <p className="text-2xs text-slate-400">Último acesso: {user.lastSeenAt ? dataHora(user.lastSeenAt) : 'nunca'}</p>
        </div>
      </div>
      <div className="min-w-0 text-xs">
        <p className="flex items-center gap-1.5 font-medium"><Dot tone={connectionTone(wa.state)} />{connectionLabel[wa.state] ?? wa.state}{wa.legacySession && <span className="font-normal text-muted">(sessão antiga)</span>}</p>
        <p className="tabular mt-0.5 text-muted">{wa.accountJid ? `+${wa.accountJid.split('@')[0].split(':')[0]}` : 'sem número'}</p>
        {wa.lastError && <p className="truncate text-2xs text-red-700" title={wa.lastError}>{wa.lastError}</p>}
      </div>
      <dl className="tabular grid min-w-0 grid-cols-4 gap-2 text-xs">
        {counts.map(([label, value, hint]) => <div key={label} title={hint || undefined}>
          <dt className="text-2xs text-muted lg:sr-only">{label}</dt>
          <dd className={`font-semibold ${label === 'Falhas' && value ? 'text-red-700' : ''}`}>{numero(value)}{hint && <span className="block text-2xs font-normal text-slate-400">{hint}</span>}</dd>
        </div>)}
      </dl>
      <div className="flex items-center justify-end gap-1.5">
        {self
          ? <ButtonLink to="/conta" size="sm" icon={IconPassword} title="A sua senha é trocada em Minha conta">Minha senha</ButtonLink>
          : <>
            <Button size="sm" icon={IconPassword} disabled={busy} aria-expanded={resetting} onClick={() => { setResetting(v => !v); setNotice(''); }}>Alterar senha</Button>
            <Menu label={`Mais ações para ${user.name}`} items={actions} disabled={busy} />
          </>}
      </div>
    </div>
    {resetting && <form onSubmit={resetPassword} className="mt-3 flex flex-wrap items-end gap-2 rounded border border-line bg-slate-50 p-3">
      <Field label={`Nova senha para ${user.name}`} hint="As sessões abertas desta conta serão encerradas." className="w-72 max-w-full">
        <PasswordInput name="password" required minLength={10} autoFocus autoComplete="new-password" placeholder="Pelo menos 10 caracteres" />
      </Field>
      <div className="flex gap-2 pb-5">
        <Button onClick={() => setResetting(false)} disabled={busy}>Cancelar</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>Salvar senha</Button>
      </div>
    </form>}
    {notice && <div className="mt-2"><Alert tone="brand">{notice}</Alert></div>}
    {error && <div className="mt-2"><Alert>{error}</Alert></div>}
  </li>;
}

// Mesma grade no cabeçalho da lista e em cada linha: as colunas ficam alinhadas.
const rowGrid = 'grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_20rem_11rem]';

function Accounts({ users, meId, onChanged }: { users: AdminUser[] | null; meId?: string; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<typeof statusFilters[number]['value']>('all');
  const [role, setRole] = useState<typeof roleFilters[number]['value']>('all');
  const term = normalize(search);
  const filtered = Boolean(term) || status !== 'all' || role !== 'all';
  const visible = (users ?? []).filter(u =>
    (status === 'all' || (status === 'active') === !u.disabledAt) &&
    (role === 'all' || u.role === role) &&
    (!term || normalize(u.name).includes(term) || normalize(u.email).includes(term)));

  return <Card>
    <CardHeader title={<span className="flex items-center gap-2">Contas{users && <span className="tabular text-xs font-normal text-muted">{filtered ? `${visible.length} de ${users.length}` : users.length}</span>}</span>}
      action={!creating && <Button size="sm" variant="primary" icon={IconAddUser} onClick={() => { setCreating(true); setCreated(''); }}>Nova conta</Button>} />
    {creating && <CreateUser onClose={() => setCreating(false)} onCreated={email => { setCreating(false); setCreated(email); onChanged(); }} />}
    {created && <div className="border-b border-line px-4 py-3"><Alert tone="brand">Conta <strong>{created}</strong> criada. Passe o e-mail e a senha inicial para a pessoa.</Alert></div>}
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      <div className="relative min-w-[12rem] flex-1">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nome ou e-mail…" aria-label="Buscar conta" className={`${inputClass} pl-8`} />
      </div>
      <Segmented label="Filtrar por situação" value={status} onChange={setStatus} options={statusFilters} />
      <Segmented label="Filtrar por papel" value={role} onChange={setRole} options={roleFilters} />
    </div>
    <div className={`${rowGrid} hidden border-b border-line bg-slate-50 px-4 py-2 text-2xs font-medium text-muted lg:grid`} aria-hidden>
      <span>Conta</span><span>WhatsApp</span>
      <span className="grid grid-cols-4 gap-2"><span>Campanhas</span><span>Grupos</span><span>Enviados</span><span>Falhas</span></span>
      <span />
    </div>
    {!users ? <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      : visible.length === 0 ? <EmptyState title={filtered ? 'Nenhuma conta com esse filtro.' : 'Nenhuma conta.'}
        action={filtered ? <Button size="sm" onClick={() => { setSearch(''); setStatus('all'); setRole('all'); }}>Limpar filtros</Button> : undefined} />
        : <ul className="divide-y divide-line">{visible.map(u => <UserRow key={u.id} user={u} self={u.id === meId} onChanged={onChanged} />)}</ul>}
  </Card>;
}

// ─── Página ─────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user: me } = useAuth();
  const { data, error, reload } = usePolling(async signal => {
    const [overview, users] = await Promise.all([api<Overview>('/admin/overview', { signal }), api<AdminUser[]>('/admin/users', { signal })]);
    return { overview, users };
  }, [], 20_000, 'admin');
  const overview = data?.overview ?? null;

  return <Page scroll>
    <PageHeader title="Administração" subtitle="Números do sistema inteiro e gestão de contas. O conteúdo das campanhas de cada conta nunca aparece aqui." />
    {error && !data && <Alert tone="warning">Não foi possível carregar o painel. Tentando de novo…</Alert>}
    <Summary overview={overview} />
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
      <Activity overview={overview} />
      <Health overview={overview} />
    </div>
    <Accounts users={data?.users ?? null} meId={me?.id} onChanged={reload} />
  </Page>;
}
