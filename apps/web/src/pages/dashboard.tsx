import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { DayDetails } from '../components/day-details';
import { api, connectionSummary } from '../lib/api';
import { SafetyAlert } from '../components/number-protection';
import { usePolling } from '../lib/use-polling';
import {
  Alert, Badge, ButtonLink, Card, CardHeader, Dot, EmptyState, Page, PageHeader, ScrollArea, Skeleton, Stat,
  IconAdd, IconCampaigns, IconClock, IconDelivered, IconMessage, IconQueue, IconReach, IconReads, IconSent, IconVideo,
  accent, hora, numero, type Tone,
} from '../design';

type NextDelivery = { campaignId: string; provider: string; status: string; nextAt: string; campaign: { name: string }; group: { name: string } };
// Situação real do próximo envio (a mesma previsão do detalhe da campanha): o servidor diz o
// tipo da espera e a tela só escolhe o selo e a frase.
type WaitKind = 'sending' | 'now' | 'quiet' | 'daily' | 'group' | 'retry' | 'offline' | 'paused' | 'pace' | 'scheduled';
type Running = {
  id: string; name: string; provider: string; sent: number; total: number; failed: number; pending: number; delivered: number;
  media: { id: string; kind: string; color: string | null } | null;
  next: { group: string; expectedAt: string; reason: string | null; kind: WaitKind } | null;
};
type Dashboard = {
  serverNow: string; activeCampaigns: number; sentToday: number; failedToday: number; readsToday: number;
  successRate: number | null; deliveredToday: number; deliveryRate: number | null;
  groupsReachedToday: number; membersReachedToday: number; pendingNow: number;
  last7Days: { day: string; sent: number }[];
  nextDelivery: NextDelivery | null;
  runningCampaigns: Running[];
  /** Uso do dia: envios do número hoje contra o limite, aquecimento e janela de silêncio. */
  usage: { used: number; limit: number | null; warmup: { day: number; days: number } | null; quiet: { start: string; end: string; active: boolean; until: string | null } | null };
};

const weekday = (iso: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)).replace('.', '');

const kindChip: Record<WaitKind, { label: string; tone: Tone }> = {
  sending: { label: 'Enviando', tone: 'brand' },
  now: { label: 'Saindo agora', tone: 'brand' },
  scheduled: { label: 'Na fila', tone: 'info' },
  pace: { label: 'No intervalo', tone: 'neutral' },
  quiet: { label: 'Em silêncio', tone: 'neutral' },
  group: { label: 'Intervalo do grupo', tone: 'neutral' },
  daily: { label: 'Limite do dia', tone: 'warning' },
  retry: { label: 'Nova tentativa', tone: 'warning' },
  offline: { label: 'Sem WhatsApp', tone: 'warning' },
  paused: { label: 'Pausada', tone: 'muted' },
};

const spDay = (at: string | number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(at));
/** "às 18:40", "amanhã às 08:00" ou "04/10 às 08:00" (horário de São Paulo). */
function quando(at: string, now: string) {
  const day = spDay(at);
  if (day === spDay(now)) return `às ${hora(at)}`;
  if (day === spDay(Date.parse(now) + 86_400_000)) return `amanhã às ${hora(at)}`;
  return `${day.slice(8, 10)}/${day.slice(5, 7)} às ${hora(at)}`;
}

/** O que acontece com o próximo envio, numa frase. */
function nextLine(next: NonNullable<Running['next']>, now: string) {
  if (next.kind === 'sending') return `Enviando para ${next.group}`;
  if (next.kind === 'now') return `Próximo: ${next.group} · saindo agora`;
  if (next.kind === 'offline') return `Próximo: ${next.group} · sai quando o WhatsApp conectar`;
  return `Próximo: ${next.group} · ${quando(next.expectedAt, now)}`;
}

/** Um número com o rótulo embaixo (os três do cartão de campanha). */
function Figure({ value, label, tone = 'text-ink' }: { value: number; label: string; tone?: string }) {
  return <div className="min-w-0">
    <p className={`tabular text-base font-semibold leading-tight ${tone}`}>{numero(value)}</p>
    <p className="truncate text-2xs text-muted">{label}</p>
  </div>;
}

/**
 * Uma campanha em andamento, em cartão: a imagem dela (para reconhecer de relance), a situação
 * real do próximo envio, a barra dividida em enviados, falhas e o que falta, e os números.
 */
function RunningCampaign({ campaign: c, now }: { campaign: Running; now: string }) {
  const chip = c.next ? kindChip[c.next.kind] : null;
  const real = c.provider === 'baileys';
  const color = accent(c.media?.color);
  const share = (n: number) => `${(n / Math.max(1, c.total)) * 100}%`;
  const live = c.next?.kind === 'sending' || c.next?.kind === 'now';
  return <li className="min-w-0">
    <Link to={`/campanhas/${c.id}`} className="group flex h-full flex-col gap-3 rounded-lg border border-line bg-white p-3.5 transition-[border-color,box-shadow] hover:border-slate-300 hover:shadow-card">
      <div className="flex items-center gap-3">
        {c.media?.kind === 'image'
          ? <img src={`/api/media/${c.media.id}/thumb`} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded object-cover" style={{ background: color.soft }} />
          : <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-slate-100 text-slate-400">{c.media?.kind === 'video' ? <IconVideo className="h-5 w-5" aria-hidden /> : <IconMessage className="h-5 w-5" aria-hidden />}</span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={c.name}>{c.name}</p>
          <p className="tabular text-2xs text-muted">{Math.round((c.sent / Math.max(1, c.total)) * 100)}% concluído{!real && ' · simulação'}</p>
        </div>
        {chip && <Badge tone={chip.tone} title={c.next?.reason ?? undefined}>
          {/* Ponto pulsando só quando algo está saindo de verdade. */}
          {live && <span aria-hidden className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-70" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-600" /></span>}
          {chip.label}
        </Badge>}
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-sm bg-slate-100" role="img" aria-label={`${c.sent} de ${c.total} enviados`}>
        <div className="h-full transition-[width] duration-500 ease-out" style={{ width: share(c.sent), background: color.solid }} />
        {c.failed > 0 && <div className="h-full bg-red-400 transition-[width] duration-500 ease-out" style={{ width: share(c.failed) }} />}
      </div>
      <div className={`grid gap-3 ${real ? 'grid-cols-4' : 'grid-cols-3'}`}>
        <Figure value={c.sent} label={`de ${numero(c.total)} enviados`} />
        {real && <Figure value={c.delivered} label={c.delivered === 1 ? 'entregue' : 'entregues'} tone="text-brand-700" />}
        <Figure value={c.pending} label={c.pending === 1 ? 'na fila' : 'na fila'} />
        <Figure value={c.failed} label={c.failed === 1 ? 'falha' : 'falhas'} tone={c.failed ? 'text-red-700' : 'text-slate-400'} />
      </div>
      {c.next && <p className="mt-auto flex items-center gap-1.5 border-t border-line pt-2.5 text-2xs text-muted" title={c.next.reason ?? undefined}>
        <IconClock className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden /><span className="truncate">{nextLine(c.next, now)}</span>
      </p>}
    </Link>
  </li>;
}

/**
 * Bloco "Hoje": quanto do limite do dia o número já usou, o aquecimento e o horário de silêncio.
 * Só leitura: as regras são ajustadas pelo administrador.
 */
function Today({ usage, now }: { usage: Dashboard['usage']; now: string }) {
  const { used, limit, warmup, quiet } = usage;
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const left = limit === null ? null : Math.max(0, limit - used);
  const tone = limit !== null && left === 0 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-brand-600';
  return <div className="space-y-4 p-4">
    <div>
      <p className="tabular flex items-baseline gap-1.5"><span className="text-2xl font-semibold leading-none">{numero(used)}</span><span className="text-xs text-muted">{limit === null ? (used === 1 ? 'envio hoje' : 'envios hoje') : `de ${numero(limit)} envios hoje`}</span></p>
      {limit !== null && <>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-sm bg-slate-100" role="img" aria-label={`${used} de ${limit} envios do dia`}><div className={`h-full transition-[width] duration-500 ease-out ${tone}`} style={{ width: `${ratio * 100}%` }} /></div>
        <p className="mt-1.5 text-2xs text-muted">{left === 0 ? 'Limite do dia atingido: os envios continuam amanhã.' : `${left === 1 ? 'Resta 1 envio' : `Restam ${numero(left!)} envios`} hoje para este número.`}</p>
      </>}
    </div>
    {(warmup || quiet) && <ul className="space-y-2.5 border-t border-line pt-3 text-xs">
      {warmup && <li className="flex items-start justify-between gap-3"><span className="text-muted">Aquecimento do número</span><span className="tabular text-right font-medium">dia {warmup.day} de {warmup.days}</span></li>}
      {quiet && <li className="flex items-start justify-between gap-3">
        <span className="text-muted">Horário de silêncio</span>
        <span className="text-right">
          <span className="tabular block font-medium">{quiet.start} às {quiet.end}</span>
          <span className={`block text-2xs ${quiet.active ? 'text-amber-700' : 'text-slate-400'}`}>{quiet.active ? `em silêncio agora${quiet.until ? ` · volta ${quando(quiet.until, now)}` : ''}` : 'envios liberados agora'}</span>
        </span>
      </li>}
    </ul>}
  </div>;
}

// Cada barra é um botão: clicar abre os números daquele dia (DayDetails, ADR-045).
function WeekBars({ days, onPick }: { days: Dashboard['last7Days']; onPick: (day: string) => void }) {
  const max = Math.max(1, ...days.map(d => d.sent));
  return <div className="flex h-full items-end gap-1.5">
    {days.map((d, i) => <button type="button" key={d.day} onClick={() => onPick(d.day)}
      aria-label={`${weekday(d.day)}: ${d.sent} ${d.sent === 1 ? 'envio' : 'envios'}. Ver o resumo do dia`} title="Ver o resumo deste dia"
      className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded">
      <span className="tabular text-2xs text-muted">{d.sent || ''}</span>
      <span className={`block w-full rounded-sm transition-[height,background-color] duration-500 ease-out ${i === days.length - 1 ? 'bg-brand-600 group-hover:bg-brand-700' : 'bg-brand-100 group-hover:bg-brand-500'}`} style={{ height: `${Math.max(3, (d.sent / max) * 72)}px` }} />
      <span className="text-2xs capitalize text-slate-400 group-hover:text-ink">{weekday(d.day)}</span>
    </button>)}
  </div>;
}

export default function DashboardPage() {
  const { data: loaded, error } = usePolling(async signal => {
    const [dashboard, { state: connection, safety }] = await Promise.all([api<Dashboard>('/dashboard', { signal }), connectionSummary(signal)]);
    return { dashboard, connection, safety };
  }, [], 15_000, 'inicio');
  const d = loaded?.dashboard ?? null;
  const connected = loaded?.connection === 'connected';
  // Aviso de pausa automática (ADR-041): some aqui na hora ao clicar em Entendi.
  const [dismissed, setDismissed] = useState(false);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const closeDay = useCallback(() => setPickedDay(null), []);
  const metric = (value: number | null | undefined, suffix = '') => (d ? `${numero(value ?? 0)}${suffix}` : '—');

  return <Page className="lg:overflow-hidden">
    <PageHeader
      title="Início"
      subtitle={<span className="inline-flex items-center gap-1.5"><Dot tone={connected ? 'ok' : 'warn'} />WhatsApp {connected ? 'conectado' : loaded?.connection === 'unavailable' ? 'indisponível' : 'desconectado'}{!connected && <Link to="/configuracoes" className="underline">conectar</Link>}</span>}
      action={<ButtonLink to="/nova-campanha" variant="primary" icon={IconAdd}>Nova campanha</ButtonLink>}
    />
    {error && <Alert tone="warning">Não foi possível atualizar os dados. Confira se o sistema está ligado.</Alert>}
    {loaded?.safety && !dismissed && <SafetyAlert notice={loaded.safety} onDismissed={() => setDismissed(true)} />}
    {pickedDay && <DayDetails day={pickedDay} onClose={closeDay} />}

    <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat icon={IconCampaigns} label="Campanhas ativas" value={metric(d?.activeCampaigns)} />
      <Stat icon={IconSent} label="Enviados hoje" value={metric(d?.sentToday)} hint={d?.failedToday ? `${d.failedToday} com falha` : 'sem falhas'} />
      <Stat icon={IconDelivered} label="Entregues hoje" value={metric(d?.deliveredToday)} hint={d?.deliveryRate == null ? 'sem envios hoje' : `${d.deliveryRate}% dos enviados`} tone="text-brand-700" />
      <Stat icon={IconReads} label="Visualizações hoje" value={metric(d?.readsToday)} />
      <Stat icon={IconReach} label="Alcance hoje" value={metric(d?.membersReachedToday)} hint={d ? `membros em ${d.groupsReachedToday} grupos` : undefined} />
      <Stat icon={IconQueue} label="Na fila" value={metric(d?.pendingNow)} hint="envios aguardando" />
    </Card>

    {/* grid-cols-1 explícito: sem ele, o CSS Grid usa colunas implícitas que crescem para caber
        no conteúdo mais largo de QUALQUER item (mesmo o de outra coluna), estourando a tela no
        celular. min-w-0 em cada item permite encolher abaixo do próprio conteúdo (mesma ideia do
        min-w-0 em flex, mas o grid não herda isso sozinho). */}
    <div className="grid min-w-0 grid-cols-1 min-h-0 flex-1 gap-4 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
      <Card className="flex min-h-[16rem] min-w-0 flex-col lg:col-span-2 lg:min-h-0">
        <CardHeader title={<span className="flex items-center gap-2">Em andamento{d && d.runningCampaigns.length > 0 && <span className="tabular text-xs font-normal text-muted">{d.runningCampaigns.length}</span>}</span>} action={<Link to="/campanhas" className="text-xs text-muted hover:text-ink">Ver todas</Link>} />
        <ScrollArea className="flex-1">
          {!d ? <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"><Skeleton className="h-36" /><Skeleton className="h-36" /></div>
            : d.runningCampaigns.length === 0 ? <EmptyState icon={IconCampaigns} title="Nenhuma campanha em andamento." hint="Quando uma campanha estiver enviando, ela aparece aqui com a situação de cada envio." action={<ButtonLink to="/nova-campanha" size="sm" icon={IconAdd}>Nova campanha</ButtonLink>} />
            : <ul className={`grid min-w-0 grid-cols-1 gap-3 p-4 ${d.runningCampaigns.length > 1 ? 'sm:grid-cols-2' : ''}`}>{d.runningCampaigns.map(c => <RunningCampaign key={c.id} campaign={c} now={d.serverNow} />)}</ul>}
        </ScrollArea>
      </Card>

      <div className="flex min-h-0 min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Hoje" />
          {d ? <Today usage={d.usage} now={d.serverNow} /> : <div className="space-y-2 p-4"><Skeleton className="h-8 w-32" /><Skeleton className="h-4" /></div>}
        </Card>
        {/* flex-1: o gráfico cresce e as duas colunas terminam na mesma linha. */}
        <Card className="flex min-h-[11rem] flex-1 flex-col p-4">
          <p className="flex items-baseline justify-between gap-2 text-xs text-muted">Envios nos últimos 7 dias<span className="text-2xs text-slate-400">clique num dia</span></p>
          <div className="mt-2 min-h-28 flex-1">{d ? <WeekBars days={d.last7Days} onPick={setPickedDay} /> : <Skeleton className="h-full" />}</div>
        </Card>
      </div>
    </div>
  </Page>;
}
