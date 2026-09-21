import { Link } from 'react-router-dom';
import { CampaignActions } from '../components/campaign-actions';
import { api, connectionState as readConnection } from '../lib/api';
import { usePolling } from '../lib/use-polling';

type Campaign = { id: string; name: string; startsAt: string; endsAt: string; status: string; provider: string; intervalSeconds: number; mode: string; groups: { group: { name: string } }[]; messages: { content: string }[]; schedules: { time: string }[] };

const statusLabel: Record<string, string> = { DRAFT: 'Rascunho', ACTIVE: 'Ativa', PAUSED: 'Pausada', CANCELLED: 'Encerrada', COMPLETED: 'Encerrada' };

export default function CampaignsPage() {
  const { data, error, reload } = usePolling(async signal => {
    const [list, connection] = await Promise.all([api<Campaign[]>('/campaigns', { signal }), readConnection(signal)]);
    return { list, connection };
  }, []);
  const campaigns = data?.list ?? null;
  const connectionState = data?.connection ?? 'unavailable';
  return <main className="p-6 md:p-12"><div className="mx-auto max-w-6xl"><header className="mb-8 flex items-center justify-between"><div><p className="text-sm font-semibold text-emerald-600">PLANEJAMENTO</p><h1 className="mt-2 text-3xl font-bold">Campanhas</h1></div><Link to="/nova-campanha" className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white">Nova campanha</Link></header>
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">{campaigns === null ? (error ? <div role="alert" className="p-8 text-amber-800"><p>Não foi possível carregar suas campanhas. Verifique se o sistema está ligado e tente novamente.</p><button type="button" onClick={reload} className="mt-3 inline-block underline">Tentar novamente</button></div> : <p className="p-8 text-slate-500">Carregando…</p>) : campaigns.length === 0 ? <p className="p-8 text-slate-500">Ainda não há campanhas. Crie a primeira para começar.</p> : <ul className="divide-y divide-slate-100">{campaigns.map(campaign => <li key={campaign.id} className="p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold"><Link to={`/campanhas/${campaign.id}`} className="hover:text-emerald-700">{campaign.name} →</Link></h2><p className="mt-1 text-sm text-slate-500">{campaign.groups.length} grupos · Intervalo: {campaign.intervalSeconds / 60} min · {campaign.mode === 'IMMEDIATE' ? 'Fila única' : campaign.schedules.map(item => item.time).join(', ')}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{statusLabel[campaign.status]}</span></div>{campaign.mode !== 'IMMEDIATE' && <p className="mt-3 text-sm text-slate-500">De {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(campaign.startsAt))} até {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(campaign.endsAt))}</p>}<Link to={`/campanhas/${campaign.id}`} className="mt-3 inline-block text-sm font-semibold text-emerald-700 underline">Ver detalhes e visualizações por grupo →</Link><CampaignActions connectionState={connectionState} id={campaign.id} status={campaign.status} provider={campaign.provider} groupCount={campaign.groups.length} intervalSeconds={campaign.intervalSeconds} mode={campaign.mode} onChanged={reload} /></li>)}</ul>}</div>
  </div></main>;
}
