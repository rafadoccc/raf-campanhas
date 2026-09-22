import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import { campaignStatus, card, data, LoadError, PageHeader, page, Pill, primaryButton } from '../components/ui';

type Campaign = {
  id: string; name: string; startsAt: string; endsAt: string; status: string; provider: string;
  intervalSeconds: number; mode: string; groups: unknown[]; schedules: { time: string }[];
  progress: Record<string, number>;
};

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const status = campaignStatus[campaign.status] ?? campaignStatus.DRAFT;
  const progress = campaign.progress ?? {}; // ausente em servidor antigo
  const total = Object.values(progress).reduce((a, b) => a + b, 0);
  const sent = progress.SENT ?? 0;
  const failed = progress.FAILED ?? 0;
  const when = campaign.mode === 'IMMEDIATE' ? 'Fila única' : campaign.schedules.map(s => s.time).join(', ');
  return <li className={`${card} flex flex-col p-5`}>
    <div className="flex items-start justify-between gap-3">
      <h2 className="font-semibold leading-snug">{campaign.name}</h2>
      <Pill tone={status.tone}>{status.label}</Pill>
    </div>
    <p className="mt-1 text-sm text-slate-500">
      {campaign.groups.length} grupos · a cada {campaign.intervalSeconds / 60} min · {when}
      {campaign.mode !== 'IMMEDIATE' && ` · ${data(campaign.startsAt)} a ${data(campaign.endsAt)}`}
      {campaign.status !== 'DRAFT' && campaign.provider === 'simulator' && ' · Simulação'}
    </p>
    {total > 0 && <div className="mt-4">
      <div className="flex justify-between text-xs text-slate-500">
        <span>{sent} de {total} enviados</span>
        {failed > 0 && <span className="text-red-700">{failed} {failed === 1 ? 'falha' : 'falhas'}</span>}
      </div>
      <progress aria-label={`Progresso de ${campaign.name}`} value={sent} max={total} className="mt-1 h-1.5 w-full accent-emerald-600" />
    </div>}
    <div className="mt-auto flex justify-end pt-5">
      <Link to={`/campanhas/${campaign.id}`} className={primaryButton}>Ver campanha →</Link>
    </div>
  </li>;
}

export default function CampaignsPage() {
  const { data: campaigns, error, reload } = usePolling(signal => api<Campaign[]>('/campaigns', { signal }), []);
  return <main className={page}>
    <PageHeader title="Campanhas" action={<Link to="/nova-campanha" className={primaryButton}>+ Nova campanha</Link>} />
    {campaigns === null
      ? (error ? <div className={card}><LoadError what="as campanhas" onRetry={reload} /></div> : <p className="text-slate-500">Carregando…</p>)
      : campaigns.length === 0
        ? <p className={`${card} p-6 text-slate-500`}>Nenhuma campanha ainda.</p>
        : <ul className="grid gap-4 md:grid-cols-2">{campaigns.map(c => <CampaignCard key={c.id} campaign={c} />)}</ul>}
  </main>;
}
