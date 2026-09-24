import { Link, useParams } from 'react-router-dom';
import { MediaPreview, type CampaignMedia } from '../components/campaign-media';
import { CampaignActions } from '../components/campaign-actions';
import { api, connectionState as readConnection } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import {
  Badge, Card, CardHeader, EmptyState, LoadMoreSentinel, Page, ScrollArea, Skeleton, Stat,
  IconBack, IconClock, IconGroups,
  accent, campaignStatus, deliveryStatus, hora, horaSeg, membros, useInfiniteList, type Wait,
} from '../design';

type Group = { name: string; participants: number | null };
type Campaign = {
  id: string; name: string; status: string; provider: string; intervalSeconds: number; mode: string;
  media: (CampaignMedia & { color?: string | null }) | null; readsTotal: number; delivered: number; progress: Record<string, number>;
  readsByGroup: { groupId: string; name: string; participants: number | null; count: number }[];
  groups: { group: Group }[]; messages: { content: string }[]; schedules: { time: string }[];
};
type Delivery = {
  id: string; status: string; provider: string; sequence: number; scheduledAt: string; sentAt: string | null;
  error: string | null; attemptedAt: string | null; deliveredAt: string | null; serverRejectedAt: string | null;
  errorCode: string | null; attempts: number; group: Group; _count: { reads: number }; wait: Wait | null;
};

// Uma linha curta com os horários que importam em cada situação.
function timeline(d: Delivery) {
  const parts = [`Previsto ${hora(d.scheduledAt)}`];
  if (d.wait && d.status === 'PENDING' && Math.abs(Date.parse(d.wait.expectedAt) - Date.parse(d.scheduledAt)) >= 60_000) parts.push(`deve sair ~${hora(d.wait.expectedAt)}`);
  if (d.status === 'SENT' && d.sentAt) parts.push(`saiu ${horaSeg(d.sentAt)}`);
  if (d.deliveredAt) parts.push(`entregue ${horaSeg(d.deliveredAt)}`);
  if (d.status === 'SENT' && d.provider === 'baileys') parts.push(`${d._count.reads} ${d._count.reads === 1 ? 'leitura' : 'leituras'}`);
  if (d.attempts > 1) parts.push(`${d.attempts} tentativas`);
  return parts.join(' · ');
}

function DeliveryRow({ d }: { d: Delivery }) {
  const status = deliveryStatus(d);
  const retrying = d.status === 'PENDING' && d.attempts > 0;
  return <li className="flex items-start justify-between gap-3 px-4 py-2.5">
    <div className="min-w-0">
      <p className="truncate text-sm font-medium"><span className="tabular mr-1.5 text-slate-400">{d.sequence + 1}</span>{d.group.name}{membros(d.group.participants) && <span className="font-normal text-slate-400"> · {membros(d.group.participants)}</span>}</p>
      <p className="mt-0.5 text-2xs text-muted">{timeline(d)}</p>
      {d.wait?.reason && <p className="mt-0.5 text-2xs text-amber-700">{d.wait.reason}</p>}
      {d.error && <p className="mt-0.5 text-2xs text-red-700">{retrying ? 'Última tentativa: ' : ''}{d.error}{d.errorCode && <span className="text-slate-400"> [{d.errorCode}]</span>}</p>}
    </div>
    <Badge tone={status.tone} title={status.title}>{status.label}</Badge>
  </li>;
}

export default function CampaignPage() {
  const id = useParams().id ?? '';
  const { data, error, reload } = usePolling(async signal => {
    const [campaign, connection] = await Promise.all([api<Campaign>(`/campaigns/${encodeURIComponent(id)}`, { signal }), readConnection(signal)]);
    return { campaign, connection };
  }, [id]);
  // Envios: 100 por página, carregados conforme a rolagem; a 1ª página (com a previsão) atualiza sozinha.
  const deliveries = useInfiniteList<Delivery>(async (cursor, signal) => {
    const page = cursor ? Number(cursor) : 0;
    const items = await api<Delivery[]>(`/deliveries?campaignId=${encodeURIComponent(id)}&page=${page}`, { signal });
    return { items, next: items.length === 100 ? String(page + 1) : null };
  }, [id]);

  if (!data) return <Page>{error ? <p>Não foi possível carregar a campanha. <Link to="/campanhas" className="underline">Voltar</Link></p> : <><Skeleton className="h-8 w-64" /><Skeleton className="h-40" /></>}</Page>;

  const { campaign, connection } = data;
  const status = campaignStatus[campaign.status] ?? campaignStatus.DRAFT;
  const color = accent(campaign.media?.color);
  const p = campaign.progress;
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const sent = p.SENT ?? 0;
  const pending = (p.PENDING ?? 0) + (p.PROCESSING ?? 0);
  const next = (deliveries.items ?? []).filter(d => d.wait?.expectedAt).sort((a, b) => Date.parse(a.wait!.expectedAt) - Date.parse(b.wait!.expectedAt))[0];
  const when = campaign.mode === 'IMMEDIATE' ? 'Fila única' : campaign.schedules.map(s => s.time).join(', ');
  const refresh = () => { reload(); deliveries.reload(); };

  return <Page className="lg:overflow-hidden">
    <Link to="/campanhas" className="inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-ink"><IconBack className="h-3.5 w-3.5" aria-hidden />Campanhas</Link>
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-5">
      <ScrollArea className="space-y-4 lg:col-span-2">
        <Card className="overflow-hidden">
          <div aria-hidden className="h-1" style={{ background: color.solid }} />
          <div className="space-y-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold" title={campaign.name}>{campaign.name}</h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  <span className="inline-flex items-center gap-1"><IconGroups className="h-3.5 w-3.5" aria-hidden />{campaign.groups.length} grupos</span>
                  <span>· a cada {campaign.intervalSeconds / 60} min · {when}</span>
                  {campaign.status !== 'DRAFT' && <span>· {campaign.provider === 'baileys' ? 'WhatsApp real' : 'simulação'}</span>}
                </p>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            {total > 0 && <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                <Stat label="Enviados" value={`${sent}/${total}`} />
                {campaign.provider === 'baileys' && <Stat label="Entregues" value={campaign.delivered ?? 0} tone="text-brand-700" />}
                <Stat label="Aguardando" value={pending} />
                <Stat label="Falhas" value={p.FAILED ?? 0} tone={p.FAILED ? 'text-red-700' : 'text-ink'} />
              </div>
              <div className="h-1 overflow-hidden rounded-sm bg-slate-100"><div className="h-full" style={{ width: `${(sent / total) * 100}%`, background: color.solid }} /></div>
            </>}
            {next && <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded bg-slate-50 px-3 py-2 text-xs"><IconClock className="h-3.5 w-3.5 text-muted" aria-hidden /><span className="text-muted">Próximo:</span><strong>{next.group.name}</strong><span>às {hora(next.wait!.expectedAt)}</span>{next.wait!.reason && <span className="text-amber-700">· {next.wait!.reason}</span>}</p>}
            <CampaignActions onChanged={refresh} connectionState={connection} id={campaign.id} name={campaign.name} status={campaign.status} provider={campaign.provider} intervalSeconds={campaign.intervalSeconds} groupCount={campaign.groups.length} />
          </div>
        </Card>

        {campaign.status === 'DRAFT' && <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Conferir antes de iniciar</h2>
          {campaign.messages.map((m, i) => <p key={i} className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm">{m.content}</p>)}
          <ol className="space-y-1 text-sm">{campaign.groups.map((g, i) => <li key={i} className="truncate"><span className="tabular mr-1.5 text-slate-400">{i + 1}</span>{g.group.name}{membros(g.group.participants) && <span className="text-slate-400"> · {membros(g.group.participants)}</span>}</li>)}</ol>
        </Card>}

        {campaign.media && <Card className="p-4"><h2 className="text-sm font-semibold">Mídia</h2><MediaPreview media={campaign.media} /></Card>}

        {campaign.provider === 'baileys' && total > 0 && <Card>
          <CardHeader title="Visualizações" action={<span className="tabular text-base font-semibold">{campaign.readsTotal}</span>} />
          <p className="px-4 pt-2 text-2xs text-muted">Leituras confirmadas pelo WhatsApp. Zero não quer dizer que não chegou.</p>
          <ul className="divide-y divide-line px-4 pb-2 text-sm">{campaign.readsByGroup.map(g => <li key={g.groupId} className="flex justify-between gap-4 py-2"><span className="truncate">{g.name}{membros(g.participants) && <span className="text-slate-400"> · {membros(g.participants)}</span>}</span><span className="tabular font-medium">{g.count}</span></li>)}</ul>
        </Card>}
      </ScrollArea>

      <Card className="flex min-h-[20rem] flex-col lg:col-span-3 lg:min-h-0">
        <CardHeader title="Envios" action={total > 0 ? <span className="tabular text-xs text-muted">{total}</span> : undefined} />
        <ScrollArea className="flex-1">
          {!deliveries.items ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
            : deliveries.items.length === 0 ? <EmptyState title="Os envios aparecem aqui quando a campanha começar." />
            : <>
              <ul className="divide-y divide-line">{deliveries.items.map(d => <DeliveryRow key={d.id} d={d} />)}</ul>
              <LoadMoreSentinel active={deliveries.hasMore} onVisible={() => void deliveries.loadMore()} />
              {deliveries.loadingMore && <p className="py-3 text-center text-xs text-muted">Carregando mais…</p>}
            </>}
        </ScrollArea>
      </Card>
    </div>
  </Page>;
}
