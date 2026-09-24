import { Link } from 'react-router-dom';
import { api, connectionState } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import {
  Alert, Badge, ButtonLink, Card, CardHeader, Dot, EmptyState, Page, PageHeader, ScrollArea, Skeleton, Stat,
  IconAdd, IconCampaigns, IconClock, IconDelivered, IconOpen, IconQueue, IconReach, IconReads, IconSent,
  dataHora, hora, numero, tempoRelativo,
} from '../design';

type NextDelivery = { campaignId: string; provider: string; status: string; nextAt: string; campaign: { name: string }; group: { name: string } };
type Dashboard = {
  serverNow: string; activeCampaigns: number; sentToday: number; failedToday: number; readsToday: number;
  successRate: number | null; deliveredToday: number; deliveryRate: number | null;
  groupsReachedToday: number; membersReachedToday: number; pendingNow: number;
  last7Days: { day: string; sent: number }[];
  nextDelivery: NextDelivery | null;
  runningCampaigns: { id: string; name: string; provider: string; sent: number; total: number; nextDelivery: NextDelivery | null }[];
  recentActivity: { id: string; campaignId: string; status: string; at: string; deliveredAt?: string | null; group: { name: string }; campaign: { name: string; deletedAt: string | null } }[];
};

const weekday = (iso: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)).replace('.', '');

function when(next: NextDelivery, now: string, connected: boolean) {
  if (next.provider === 'baileys' && !connected) return 'aguardando o WhatsApp conectar';
  if (next.status === 'PROCESSING') return 'enviando agora';
  const inMs = Date.parse(next.nextAt) - Date.parse(now);
  return inMs > 30_000 ? `às ${hora(next.nextAt)} · ${tempoRelativo(next.nextAt, Date.parse(now))}` : 'saindo agora';
}

function WeekBars({ days }: { days: Dashboard['last7Days'] }) {
  const max = Math.max(1, ...days.map(d => d.sent));
  return <div className="flex h-full items-end gap-1.5" role="img" aria-label={`Envios dos últimos 7 dias: ${days.map(d => d.sent).join(', ')}`}>
    {days.map((d, i) => <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${weekday(d.day)}: ${d.sent} envios`}>
      <span className="tabular text-2xs text-muted">{d.sent || ''}</span>
      <div className={`w-full rounded-sm ${i === days.length - 1 ? 'bg-brand-600' : 'bg-brand-100'}`} style={{ height: `${Math.max(3, (d.sent / max) * 72)}px` }} />
      <span className="text-2xs capitalize text-slate-400">{weekday(d.day)}</span>
    </div>)}
  </div>;
}

export default function DashboardPage() {
  const { data: loaded, error } = usePolling(async signal => {
    const [dashboard, connection] = await Promise.all([api<Dashboard>('/dashboard', { signal }), connectionState(signal)]);
    return { dashboard, connection };
  }, []);
  const d = loaded?.dashboard ?? null;
  const connected = loaded?.connection === 'connected';
  const metric = (value: number | null | undefined, suffix = '') => (d ? `${numero(value ?? 0)}${suffix}` : '—');

  return <Page className="lg:overflow-hidden">
    <PageHeader
      title="Início"
      subtitle={<span className="inline-flex items-center gap-1.5"><Dot tone={connected ? 'ok' : 'warn'} />WhatsApp {connected ? 'conectado' : loaded?.connection === 'unavailable' ? 'indisponível' : 'desconectado'}{!connected && <Link to="/configuracoes" className="underline">conectar</Link>}</span>}
      action={<ButtonLink to="/nova-campanha" variant="primary" icon={IconAdd}>Nova campanha</ButtonLink>}
    />
    {error && <Alert tone="warning">Não foi possível atualizar os dados. Confira se o sistema está ligado.</Alert>}

    <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat icon={IconCampaigns} label="Campanhas ativas" value={metric(d?.activeCampaigns)} />
      <Stat icon={IconSent} label="Enviados hoje" value={metric(d?.sentToday)} hint={d?.failedToday ? `${d.failedToday} com falha` : 'sem falhas'} />
      <Stat icon={IconDelivered} label="Entregues hoje" value={metric(d?.deliveredToday)} hint={d?.deliveryRate == null ? 'sem envios hoje' : `${d.deliveryRate}% dos enviados`} tone="text-brand-700" />
      <Stat icon={IconReads} label="Visualizações hoje" value={metric(d?.readsToday)} />
      <Stat icon={IconReach} label="Alcance hoje" value={metric(d?.membersReachedToday)} hint={d ? `membros em ${d.groupsReachedToday} grupos` : undefined} />
      <Stat icon={IconQueue} label="Na fila" value={metric(d?.pendingNow)} hint="envios aguardando" />
    </Card>

    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-4 lg:col-span-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted"><IconClock className="h-3.5 w-3.5" aria-hidden />Próximo envio</p>
            {!d ? <Skeleton className="mt-2 h-12" /> : d.nextDelivery ? <>
              <p className="mt-1 truncate text-base font-semibold">{d.nextDelivery.group.name}</p>
              <p className="truncate text-xs text-muted"><Link to={`/campanhas/${d.nextDelivery.campaignId}`} className="hover:underline">{d.nextDelivery.campaign.name}</Link> · {when(d.nextDelivery, d.serverNow, connected)}{d.nextDelivery.provider === 'simulator' && ' · simulação'}</p>
            </> : <p className="mt-2 text-sm text-muted">Nada na fila agora.</p>}
          </Card>
          <Card className="flex flex-col p-4">
            <p className="text-xs text-muted">Envios nos últimos 7 dias</p>
            <div className="mt-2 h-24">{d ? <WeekBars days={d.last7Days} /> : <Skeleton className="h-full" />}</div>
          </Card>
        </div>
        <Card className="flex min-h-[14rem] flex-1 flex-col lg:min-h-0">
          <CardHeader title="Em andamento" action={<Link to="/campanhas" className="text-xs text-muted hover:text-ink">Ver todas</Link>} />
          <ScrollArea className="flex-1">
            {!d ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
              : d.runningCampaigns.length === 0 ? <EmptyState title="Nenhuma campanha ativa." />
              : <ul className="divide-y divide-line">{d.runningCampaigns.map(c => <li key={c.id}>
                <Link to={`/campanhas/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3 text-sm"><span className="truncate font-medium">{c.name}</span><span className="tabular shrink-0 text-xs text-muted">{c.sent}/{c.total}</span></div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-slate-100"><div className="h-full bg-brand-600" style={{ width: `${(c.sent / Math.max(1, c.total)) * 100}%` }} /></div>
                    {c.nextDelivery && <p className="mt-1 truncate text-2xs text-muted">Próximo: {c.nextDelivery.group.name} · {when(c.nextDelivery, d.serverNow, connected)}</p>}
                  </div>
                  <IconOpen className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                </Link>
              </li>)}</ul>}
          </ScrollArea>
        </Card>
      </div>

      <Card className="flex min-h-[16rem] flex-col lg:min-h-0">
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
