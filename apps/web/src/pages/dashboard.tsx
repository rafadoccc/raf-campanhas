import { Link } from 'react-router-dom';
import { api, connectionState } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import { card, dataHora, hora, PageHeader, page, primaryButton } from '../components/ui';

type NextDelivery = { campaignId: string; provider: string; status: string; nextAt: string; campaign: { name: string }; group: { name: string } };
type Dashboard = {
  serverNow: string; activeCampaigns: number; sentToday: number; failedToday: number;
  successRate: number | null; readsToday: number; nextDelivery: NextDelivery | null;
  runningCampaigns: { id: string; name: string; provider: string; sent: number; total: number; nextDelivery: NextDelivery | null }[];
  recentActivity: { id: string; campaignId: string; status: string; at: string; group: { name: string }; campaign: { name: string; deletedAt: string | null } }[];
};

function whenNext(next: NextDelivery, now: string, connected: boolean) {
  if (next.provider === 'baileys' && !connected) return 'aguardando o WhatsApp conectar';
  if (next.status === 'PROCESSING') return 'enviando agora';
  const minutes = Math.ceil((Date.parse(next.nextAt) - Date.parse(now)) / 60000);
  return minutes > 0 ? `às ${hora(next.nextAt)} (em ${minutes} min)` : 'saindo agora';
}

export default function DashboardPage() {
  const { data: loaded, error } = usePolling(async signal => {
    const [dashboard, connection] = await Promise.all([api<Dashboard>('/dashboard', { signal }), connectionState(signal)]);
    return { dashboard, connection };
  }, []);
  const data = loaded?.dashboard ?? null;
  const connected = loaded?.connection === 'connected';
  const metrics: [string, string | number][] = [
    ['Campanhas ativas', data?.activeCampaigns ?? '—'],
    ['Enviados hoje', data?.sentToday ?? '—'],
    ['Visualizações hoje', data?.readsToday ?? '—'],
    ['Sucesso hoje', data?.successRate == null ? '—' : `${data.successRate}%`],
  ];

  return <main className={page}>
    <PageHeader title="Painel" action={<Link to="/nova-campanha" className={primaryButton}>+ Nova campanha</Link>} />

    <p role="status" className="mb-6 flex items-center gap-2 text-sm">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      <span className={connected ? 'text-emerald-800' : 'text-amber-800'}>WhatsApp {connected ? 'conectado' : loaded?.connection === 'unavailable' ? 'indisponível' : 'desconectado'}</span>
      {!connected && <Link to="/configuracoes" className="text-slate-500 underline">Conectar</Link>}
    </p>

    {error && <p role="alert" className="mb-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">Não foi possível carregar os dados. Confira se o sistema está ligado.</p>}

    <section aria-label="Resumo de hoje" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {metrics.map(([label, value]) => <div key={label} className={`${card} p-4`}><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-3xl font-bold tracking-tight">{value}</p></div>)}
    </section>

    {data?.nextDelivery && <section className={`${card} mt-6 border-l-4 border-l-emerald-500 p-5`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Próximo envio</p>
      <p className="mt-1 text-lg font-bold">{data.nextDelivery.group.name}</p>
      <p className="text-sm text-slate-500">
        <Link to={`/campanhas/${data.nextDelivery.campaignId}`} className="underline">{data.nextDelivery.campaign.name}</Link>
        {' · '}{whenNext(data.nextDelivery, data.serverNow, connected)}{data.nextDelivery.provider === 'simulator' && ' · simulação'}
      </p>
    </section>}

    <div className="mt-8 grid gap-8 lg:grid-cols-2">
      <section>
        <h2 className="mb-3 font-semibold">Em andamento</h2>
        {data?.runningCampaigns.length
          ? <ul className="space-y-3">{data.runningCampaigns.map(c => <li key={c.id}><Link to={`/campanhas/${c.id}`} className={`${card} block p-4 hover:border-emerald-300`}>
            <div className="flex justify-between gap-3 text-sm"><span className="font-semibold">{c.name}</span><span className="text-slate-500">{c.sent}/{c.total}</span></div>
            <progress aria-label={`Progresso de ${c.name}`} value={c.sent} max={Math.max(1, c.total)} className="mt-2 h-1.5 w-full accent-emerald-600" />
            {c.nextDelivery && <p className="mt-2 text-xs text-slate-500">Próximo: {c.nextDelivery.group.name} · {whenNext(c.nextDelivery, data.serverNow, connected)}</p>}
          </Link></li>)}</ul>
          : <p className="text-sm text-slate-500">{data ? 'Nenhuma campanha ativa.' : '—'}</p>}
      </section>
      <section>
        <h2 className="mb-3 font-semibold">Atividade recente</h2>
        {data?.recentActivity.length
          ? <ul className={`${card} divide-y divide-slate-100`}>{data.recentActivity.map(event => <li key={event.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0"><span className={event.status === 'FAILED' ? 'text-red-700' : ''}>{event.status === 'FAILED' ? '✕ ' : '✓ '}{event.group.name}</span>
              <span className="block truncate text-xs text-slate-500">{event.campaign.deletedAt ? `${event.campaign.name} (excluída)` : <Link to={`/campanhas/${event.campaignId}`} className="hover:underline">{event.campaign.name}</Link>}</span></span>
            <time dateTime={event.at} className="shrink-0 text-xs text-slate-500">{dataHora(event.at)}</time>
          </li>)}</ul>
          : <p className="text-sm text-slate-500">{data ? 'Nenhum envio real ainda.' : '—'}</p>}
      </section>
    </div>
  </main>;
}
