import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { DayDetails } from '../components/day-details';
import { api, connectionSummary } from '../lib/api';
import { SafetyAlert } from '../components/number-protection';
import { usePolling } from '../lib/use-polling';
import {
  Alert, Badge, ButtonLink, Card, CardHeader, Dot, EmptyState, Page, PageHeader, ScrollArea, Skeleton, Stat,
  IconAdd, IconCampaigns, IconDelivered, IconOpen, IconQueue, IconReach, IconReads, IconSent,
  dataHora, hora, numero, type Tone,
} from '../design';

type NextDelivery = { campaignId: string; provider: string; status: string; nextAt: string; campaign: { name: string }; group: { name: string } };
// Situação real do próximo envio (a mesma previsão do detalhe da campanha): o servidor diz o
// tipo da espera e a tela só escolhe o selo e a frase.
type WaitKind = 'sending' | 'now' | 'quiet' | 'daily' | 'group' | 'retry' | 'offline' | 'paused' | 'pace' | 'scheduled';
type Running = {
  id: string; name: string; provider: string; sent: number; total: number; failed: number; pending: number; delivered: number;
  next: { group: string; expectedAt: string; reason: string | null; kind: WaitKind } | null;
};
type Dashboard = {
  serverNow: string; activeCampaigns: number; sentToday: number; failedToday: number; readsToday: number;
  successRate: number | null; deliveredToday: number; deliveryRate: number | null;
  groupsReachedToday: number; membersReachedToday: number; pendingNow: number;
  last7Days: { day: string; sent: number }[];
  nextDelivery: NextDelivery | null;
  runningCampaigns: Running[];
  recentActivity: { id: string; campaignId: string; status: string; at: string; deliveredAt?: string | null; group: { name: string }; campaign: { name: string; deletedAt: string | null } }[];
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

/** Uma campanha em andamento: nome e situação real, progresso, números do que já saiu e o próximo envio. */
function RunningCampaign({ campaign: c, now }: { campaign: Running; now: string }) {
  const chip = c.next ? kindChip[c.next.kind] : null;
  const real = c.provider === 'baileys';
  return <li>
    <Link to={`/campanhas/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm font-medium">{c.name}{!real && <span className="ml-1.5 text-2xs font-normal text-slate-400">simulação</span>}</span>
          {chip && <Badge tone={chip.tone} title={c.next?.reason ?? undefined}>{chip.label}</Badge>}
        </div>
        <div className="h-1 overflow-hidden rounded-sm bg-slate-100"><div className="h-full bg-brand-600 transition-[width] duration-500 ease-out" style={{ width: `${(c.sent / Math.max(1, c.total)) * 100}%` }} /></div>
        <p className="tabular flex flex-wrap gap-x-3 text-2xs text-muted">
          <span><strong className="font-semibold text-ink">{c.sent}</strong> de {c.total} enviados</span>
          {real && <span>{c.delivered} {c.delivered === 1 ? 'entregue' : 'entregues'}</span>}
          {c.failed > 0 && <span className="text-red-700">{c.failed} {c.failed === 1 ? 'falha' : 'falhas'}</span>}
          <span>{c.pending === 1 ? 'falta 1' : `faltam ${c.pending}`}</span>
        </p>
        {c.next && <p className="truncate text-2xs text-muted" title={c.next.reason ?? undefined}>{nextLine(c.next, now)}</p>}
      </div>
      <IconOpen className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
    </Link>
  </li>;
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
      <div className="flex min-h-0 min-w-0 flex-col gap-4 lg:col-span-2">
        <Card className="flex flex-col p-4">
          <p className="flex items-baseline justify-between gap-2 text-xs text-muted">Envios nos últimos 7 dias<span className="text-2xs text-slate-400">clique num dia para ver o resumo</span></p>
          <div className="mt-2 h-28">{d ? <WeekBars days={d.last7Days} onPick={setPickedDay} /> : <Skeleton className="h-full" />}</div>
        </Card>
        <Card className="flex min-h-[14rem] flex-1 flex-col lg:min-h-0">
          <CardHeader title="Em andamento" action={<Link to="/campanhas" className="text-xs text-muted hover:text-ink">Ver todas</Link>} />
          <ScrollArea className="flex-1">
            {!d ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
              : d.runningCampaigns.length === 0 ? <EmptyState title="Nenhuma campanha ativa." />
              : <ul className="divide-y divide-line">{d.runningCampaigns.map(c => <RunningCampaign key={c.id} campaign={c} now={d.serverNow} />)}</ul>}
          </ScrollArea>
        </Card>
      </div>

      <Card className="flex min-h-[16rem] min-w-0 flex-col lg:min-h-0">
        <CardHeader title="Atividade recente" />
        <ScrollArea className="flex-1">
          {!d ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            : d.recentActivity.length === 0 ? <EmptyState title="Nenhum envio real ainda." />
            : <ul className="divide-y divide-line">{d.recentActivity.map(event => <li key={event.id} className="flex items-start justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{event.group.name}</p>
                <p className="truncate text-2xs text-muted">{event.campaign.deletedAt ? `${event.campaign.name} (excluída)` : <Link to={`/campanhas/${event.campaignId}`} className="hover:underline">{event.campaign.name}</Link>} · {dataHora(event.at)}</p>
              </div>
              {event.status === 'FAILED' ? <Badge tone="danger">Falhou</Badge> : event.deliveredAt ? <Badge tone="brand">Entregue</Badge> : <Badge tone="neutral">Enviado</Badge>}
            </li>)}</ul>}
        </ScrollArea>
      </Card>
    </div>
  </Page>;
}
