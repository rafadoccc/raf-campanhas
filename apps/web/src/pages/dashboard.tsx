import { Link } from 'react-router-dom';
import { api, connectionState } from '../lib/api';
import { usePolling } from '../lib/use-polling';

type NextDelivery = { campaignId: string; provider: string; status: string; nextAt: string; campaign: { name: string }; group: { name: string } };
type Dashboard = {
  serverNow: string; activeCampaigns: number; sentToday: number; failedToday: number;
  successRate: number | null; readsToday: number; nextDelivery: NextDelivery | null;
  runningCampaigns: { id: string; name: string; provider: string; sent: number; total: number; nextDelivery: NextDelivery | null }[];
  recentActivity: { id: string; campaignId: string; status: string; at: string; group: { name: string }; campaign: { name: string; deletedAt: string | null } }[];
};
const format = (at: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
function estimate(next: NextDelivery, now: string, connected: boolean) {
  if (next.provider === 'baileys' && !connected) return 'Aguardando conexão com o WhatsApp.';
  if (next.status === 'PROCESSING') return 'Envio em processamento.';
  const minutes = Math.ceil((Date.parse(next.nextAt) - Date.parse(now)) / 60000);
  return minutes > 0 ? `Em aproximadamente ${minutes} min.` : 'Horário atingido; aguardando processamento.';
}
export default function DashboardPage() {
  const { data: loaded, error } = usePolling(async signal => {
    const [dashboard, connection] = await Promise.all([api<Dashboard>('/dashboard', { signal }), connectionState(signal)]);
    return { dashboard, connection };
  }, []);
  const data = loaded?.dashboard ?? null;
  const connection = loaded?.connection ?? 'unavailable';
  const connected = connection === 'connected';
  const metrics = [
    ['Campanhas ativas', data?.activeCampaigns ?? '—'],
    ['Envios reais hoje', data?.sentToday ?? '—'],
    ['Visualizações confirmadas hoje', data?.readsToday ?? '—'],
    ['Sucesso dos envios hoje', data?.successRate == null ? '—' : `${data.successRate}%`]
  ];
  return <main className="p-6 md:p-12"><div className="mx-auto max-w-6xl">
    <header className="flex flex-wrap items-start justify-between gap-5">
      <div><p className="text-sm font-semibold text-emerald-600">CENTRAL DE CAMPANHAS <span aria-hidden="true" className="ml-2 font-mono">:)</span></p><h1 className="mt-3 text-3xl font-bold md:text-4xl">Tudo no seu ritmo.</h1><p className="mt-3 text-slate-500">O que está acontecendo agora, um grupo de cada vez.</p></div>
      <Link to="/nova-campanha" className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white">Nova campanha</Link>
    </header>
    <div role="status" className="mt-6 flex flex-wrap items-center gap-3 text-sm">
      <span className={connected ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-800'}><span aria-hidden="true">● </span>WhatsApp {connected ? 'conectado' : connection === 'unavailable' ? 'indisponível — conexão não confirmada' : 'desconectado'}</span>
      <Link to="/configuracoes" className="text-slate-500 underline">Ver conexão</Link>
      {!connected && <span className="text-slate-500">Envios reais aguardam a conexão.</span>}
    </div>
    {!data && !error && <p className="mt-8 text-slate-500">Carregando…</p>}
    {error && <p role="alert" className="mt-8 rounded-lg bg-amber-50 p-4 text-amber-800">Não foi possível consultar os dados. Verifique se a API e o banco estão funcionando.</p>}
    <section aria-label="Resumo de hoje" className="mt-10 grid gap-8 border-y border-slate-200 py-8 sm:grid-cols-2 lg:grid-cols-4">{metrics.map(([label, value]) => <div key={label}><p className="text-sm text-slate-500">{label}</p><strong className="mt-3 block text-4xl tracking-tight">{value}</strong></div>)}</section>
    <p className="mt-3 text-xs leading-relaxed text-slate-500">Hoje = dia de Brasília, não últimas 24 horas. Sucesso = enviados ÷ (enviados + falhas registradas hoje), sem simulações; sem resultados, mostramos —. Não confirma leitura. Totais das campanhas são históricos.</p>
    <section className="my-10 border-l-4 border-emerald-500 pl-6" aria-labelledby="next-title"><h2 id="next-title" className="text-sm font-semibold uppercase tracking-wide text-emerald-700">Próximo envio</h2>
      {data?.nextDelivery ? <><p className="mt-3 text-2xl font-bold">{data.nextDelivery.group.name}</p><Link to={`/campanhas/${data.nextDelivery.campaignId}`} className="mt-2 inline-block text-slate-600 underline">{data.nextDelivery.campaign.name}</Link><p className="mt-3 font-semibold">{format(data.nextDelivery.nextAt)} · Brasília{data.nextDelivery.provider === 'simulator' && ' · Simulação'}</p><p className="mt-1 text-sm text-slate-500">{estimate(data.nextDelivery, data.serverNow, connected)}</p></> : <p className="mt-3 text-slate-500">{data ? 'Nenhum envio pendente em campanhas ativas.' : 'Próximo envio indisponível.'}</p>}
      <p className="mt-3 text-xs text-slate-500">Previsão sujeita ao processamento, à conexão e às pausas. Atualização a cada 15 segundos enquanto a página estiver visível.</p>
    </section>
    <div className="grid gap-12 border-t border-slate-200 pt-8 lg:grid-cols-2">
      <section><h2 className="text-xl font-bold">Campanhas em andamento</h2>
        {data?.runningCampaigns.length ? <ul className="mt-4 divide-y divide-slate-200">{data.runningCampaigns.map(c => <li key={c.id} className="py-5"><Link to={`/campanhas/${c.id}`} className="block rounded focus:outline-emerald-600"><h3 className="font-semibold text-emerald-800">{c.name} →</h3><p className="mt-2 text-sm">{c.sent} de {c.total} {c.provider === 'simulator' ? 'simulados' : 'enviados'}</p><progress aria-label={`Progresso de ${c.name}`} value={c.sent} max={Math.max(1, c.total)} className="mt-3 h-2 w-full accent-emerald-600" /><p className="mt-2 text-sm text-slate-500">{c.nextDelivery ? `${c.nextDelivery.status === 'PROCESSING' ? 'Em processamento' : 'Próximo envio'}: ${c.nextDelivery.group.name} • ${format(c.nextDelivery.nextAt)}` : 'Sem envios pendentes.'}</p>{c.provider === 'baileys' && !connected && <p className="mt-1 text-sm text-amber-800">Aguardando conexão.</p>}</Link></li>)}</ul> : <p className="mt-5 text-sm text-slate-500">{data ? 'Nenhuma campanha ativa agora.' : 'Campanhas indisponíveis.'}</p>}
      </section>
      <section><h2 className="text-xl font-bold">Atividade recente</h2><p className="mt-2 text-xs text-slate-500">Últimos resultados reais registrados. Falhas usam a data de atualização do registro, não um log completo de tentativas.</p>
        {data?.recentActivity.length ? <ul className="mt-4 divide-y divide-slate-200">{data.recentActivity.map(event => <li key={event.id} className="py-4"><time dateTime={event.at} className="text-xs text-slate-500">{format(event.at)} · Brasília</time><p className={event.status === 'FAILED' ? 'mt-1 text-red-700' : 'mt-1 font-medium'}>{event.status === 'FAILED' ? `Falha registrada para ${event.group.name}` : `${event.group.name} enviado ✓`}</p>{event.campaign.deletedAt ? <p className="mt-1 text-xs text-slate-500">{event.campaign.name} · campanha excluída</p> : <Link to={`/campanhas/${event.campaignId}`} className="mt-1 inline-block text-xs text-slate-500 underline">{event.campaign.name}</Link>}</li>)}</ul> : <p className="mt-5 text-sm text-slate-500">{data ? 'Nenhum resultado de envio real registrado.' : 'Atividade indisponível.'}</p>}
      </section>
    </div>
  </div></main>;
}
