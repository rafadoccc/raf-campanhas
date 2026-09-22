import { Link, useParams, useSearchParams } from 'react-router-dom';
import { MediaPreview, type CampaignMedia } from '../components/campaign-media';
import { CampaignActions } from '../components/campaign-actions';
import { api, connectionState as readConnection } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import { campaignStatus, card, deliveryStatus, hora, horaSeg, membros, page, Pill, type Wait } from '../components/ui';

type Group = { name: string; participants: number | null };
type Campaign = {
  id: string; name: string; status: string; provider: string; intervalSeconds: number; mode: string;
  media: CampaignMedia | null; readsTotal: number; delivered: number; progress: Record<string, number>;
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
  return <li className="flex items-start justify-between gap-3 px-5 py-3">
    <div className="min-w-0">
      <p className="font-medium">{d.sequence + 1}. {d.group.name}{membros(d.group.participants) && <span className="font-normal text-slate-400"> · {membros(d.group.participants)}</span>}</p>
      <p className="mt-0.5 text-xs text-slate-500">{timeline(d)}</p>
      {d.wait?.reason && <p className="mt-0.5 text-xs text-amber-700">{d.wait.reason}</p>}
      {d.error && <p className="mt-0.5 text-xs text-red-700">{retrying ? 'Última tentativa: ' : ''}{d.error}{d.errorCode && <span className="text-slate-400"> [{d.errorCode}]</span>}</p>}
    </div>
    <Pill tone={status.tone} title={status.title}>{status.label}</Pill>
  </li>;
}

function Stat({ label, value, tone = '' }: { label: string; value: number | string; tone?: string }) {
  return <div><p className="text-xs text-slate-500">{label}</p><p className={`text-xl font-bold ${tone}`}>{value}</p></div>;
}

export default function CampaignPage() {
  const id = useParams().id ?? '';
  const [query] = useSearchParams();
  const pageNumber = Math.max(0, parseInt(query.get('page') ?? '0') || 0);
  const { data, error, reload } = usePolling(async signal => {
    const [campaign, deliveries, connection] = await Promise.all([
      api<Campaign>(`/campaigns/${encodeURIComponent(id)}`, { signal }),
      api<Delivery[]>(`/deliveries?campaignId=${encodeURIComponent(id)}&page=${pageNumber}`, { signal }),
      readConnection(signal)
    ]);
    return { campaign, deliveries, connection };
  }, [id, pageNumber]);
  if (!data) return <main className={page}>{error ? <p>Não foi possível carregar a campanha. <Link to="/campanhas" className="underline">Voltar</Link></p> : <p className="text-slate-500">Carregando…</p>}</main>;

  const { campaign, deliveries, connection } = data;
  const status = campaignStatus[campaign.status] ?? campaignStatus.DRAFT;
  const p = campaign.progress;
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  const sent = p.SENT ?? 0;
  const pending = (p.PENDING ?? 0) + (p.PROCESSING ?? 0);
  // Próximo a sair, com o motivo da espera (se houver).
  const next = deliveries.filter(d => d.wait?.expectedAt).sort((a, b) => Date.parse(a.wait!.expectedAt) - Date.parse(b.wait!.expectedAt))[0];
  const when = campaign.mode === 'IMMEDIATE' ? 'Fila única' : campaign.schedules.map(s => s.time).join(', ');

  return <main className={`${page} space-y-5`}>
    <Link to="/campanhas" className="text-sm text-slate-500 hover:text-slate-900">← Campanhas</Link>

    <section className={`${card} p-6`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{campaign.name}</h1>
          <p className="mt-1 text-sm text-slate-500">{campaign.groups.length} grupos · a cada {campaign.intervalSeconds / 60} min · {when}{campaign.status !== 'DRAFT' && (campaign.provider === 'baileys' ? ' · WhatsApp real' : ' · Simulação')}</p>
        </div>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      {total > 0 && <>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Enviados" value={`${sent}/${total}`} />
          {campaign.provider === 'baileys' && <Stat label="Entregues ✓✓" value={campaign.delivered ?? 0} tone="text-emerald-700" />}
          <Stat label="Aguardando" value={pending} />
          <Stat label="Falhas" value={p.FAILED ?? 0} tone={p.FAILED ? 'text-red-700' : ''} />
        </div>
        <progress aria-label="Progresso de envios" value={sent} max={total} className="mt-4 h-1.5 w-full accent-emerald-600" />
      </>}
      {next && <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm">
        <span className="text-slate-500">Próximo:</span> <strong>{next.group.name}</strong> às {hora(next.wait!.expectedAt)}
        {next.wait!.reason && <span className="text-amber-700"> · {next.wait!.reason}</span>}
      </p>}
      <CampaignActions onChanged={reload} connectionState={connection} id={id} status={campaign.status} provider={campaign.provider} intervalSeconds={campaign.intervalSeconds} groupCount={campaign.groups.length} />
    </section>

    {campaign.status === 'DRAFT' && <section className={`${card} space-y-3 p-6`}>
      <h2 className="font-semibold">Conferir antes de iniciar</h2>
      {campaign.messages.map((m, i) => <p key={i} className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{m.content}</p>)}
      <ol className="space-y-1 text-sm">{campaign.groups.map((g, i) => <li key={i}>{i + 1}. {g.group.name}{membros(g.group.participants) && <span className="text-slate-400"> · {membros(g.group.participants)}</span>}</li>)}</ol>
    </section>}

    {campaign.media && <section className={`${card} p-6`}><h2 className="font-semibold">Mídia</h2><MediaPreview media={campaign.media} /></section>}

    {deliveries.length > 0 && <section className={card}>
      <h2 className="px-5 pb-2 pt-5 font-semibold">Envios</h2>
      <ul className="divide-y divide-slate-100">{deliveries.map(d => <DeliveryRow key={d.id} d={d} />)}</ul>
      {(pageNumber > 0 || deliveries.length === 100) && <div className="flex justify-between border-t p-4 text-sm text-emerald-700">
        {pageNumber > 0 ? <Link to={`?page=${pageNumber - 1}`}>← Anteriores</Link> : <span />}
        {deliveries.length === 100 && <Link to={`?page=${pageNumber + 1}`}>Próximos →</Link>}
      </div>}
    </section>}

    {campaign.provider === 'baileys' && total > 0 && <section className={`${card} p-6`}>
      <div className="flex items-baseline justify-between"><h2 className="font-semibold">Visualizações</h2><span className="text-xl font-bold">{campaign.readsTotal}</span></div>
      <p className="mt-1 text-xs text-slate-500">Leituras confirmadas pelo WhatsApp. Zero não quer dizer que não chegou.</p>
      <ul className="mt-3 divide-y divide-slate-100 text-sm">{campaign.readsByGroup.map(g => <li key={g.groupId} className="flex justify-between gap-4 py-2"><span>{g.name}{membros(g.participants) && <span className="text-slate-400"> · {membros(g.participants)}</span>}</span><span className="font-medium">{g.count}</span></li>)}</ul>
    </section>}
  </main>;
}
