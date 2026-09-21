import { Link, useParams, useSearchParams } from 'react-router-dom';
import { MediaPreview, type CampaignMedia } from '../components/campaign-media';
import { CampaignActions } from '../components/campaign-actions';
import { api, connectionState as readConnection } from '../lib/api';
import { usePolling } from '../lib/use-polling';
type Campaign = { media: CampaignMedia | null; serverNow: string; readsTotal: number; readsByGroup: { groupId: string; name: string; count: number }[]; id: string; name: string; status: string; provider: string; intervalSeconds: number; mode: string; nextAt: string | null; progress: Record<string, number>; groups: { group: { name: string } }[]; messages: { content: string }[] };
type Delivery = { id: string; status: string; provider: string; sequence: number; sentAt: string | null; scheduledAt: string; error: string | null; group: { name: string }; _count: { reads: number } };
const labels: Record<string, string> = { DRAFT: 'Rascunho', ACTIVE: 'Ativa', PAUSED: 'Pausada', COMPLETED: 'Encerrada', CANCELLED: 'Encerrada', PENDING: 'Aguardando', PROCESSING: 'Enviando', SENT: 'Enviado ✓', FAILED: 'Falhou' };
export default function CampaignPage() {
  const id = useParams().id ?? '';
  const [query] = useSearchParams();
  const page = Math.max(0, parseInt(query.get('page') ?? '0') || 0);
  const { data, error, reload } = usePolling(async signal => {
    const [campaign, deliveries, connection] = await Promise.all([
      api<Campaign>(`/campaigns/${encodeURIComponent(id)}`, { signal }),
      api<Delivery[]>(`/deliveries?campaignId=${encodeURIComponent(id)}&page=${page}`, { signal }),
      readConnection(signal)
    ]);
    return { campaign, deliveries, connection };
  }, [id, page]);
  if (!data) return error
    ? <main className="p-12"><p>Não foi possível carregar a campanha. Confira se o sistema está ligado ou se a campanha foi excluída.</p><Link to="/campanhas">Voltar</Link></main>
    : <main className="p-12 text-slate-500">Carregando…</main>;
  const { campaign, deliveries, connection: connectionState } = data;
  const total = Object.values(campaign.progress).reduce((a, b) => a + b, 0);
  const sent = campaign.progress.SENT ?? 0; const failed = campaign.progress.FAILED ?? 0;
  const minutes = campaign.nextAt ? Math.max(0, Math.ceil((new Date(campaign.nextAt).getTime() - new Date(campaign.serverNow).getTime()) / 60000)) : 0;
  return <main className="p-6 md:p-12"><div className="mx-auto max-w-5xl space-y-6"><Link to="/campanhas" className="text-sm text-emerald-700">← Campanhas</Link>
    <section className="rounded-xl border bg-white p-6 shadow-sm"><p className="text-sm font-semibold text-emerald-700">{labels[campaign.status]}</p><h1 className="mt-2 text-3xl font-bold">{campaign.name}</h1><p className="mt-3 text-slate-500">{campaign.groups.length} grupos · Intervalo {campaign.intervalSeconds / 60} min · {campaign.mode === 'IMMEDIATE' ? 'Fila única' : 'Rodadas agendadas'}</p>
      {campaign.media && <div className="mt-5 border-t pt-4"><h2 className="font-semibold">Mídia da campanha</h2><MediaPreview media={campaign.media} /><p className="mt-2 text-sm text-slate-500">Mídia + legenda contam como um único envio para cada grupo. A mídia é preservada no histórico.</p></div>}
      <CampaignActions onChanged={reload} connectionState={connectionState} id={id} status={campaign.status} provider={campaign.provider} intervalSeconds={campaign.intervalSeconds} mode={campaign.mode} groupCount={campaign.groups.length} />
      {campaign.status === 'DRAFT' && <div className="mt-4 space-y-2 border-t pt-4"><h2 className="font-semibold">Confira antes de iniciar</h2><p className="text-sm">Duração mínima por rodada: {Math.max(0, campaign.groups.length - 1) * campaign.intervalSeconds / 60} minutos. O primeiro envio não espera o intervalo.</p>{campaign.messages.map((m, i) => <p key={i} className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm">{m.content}</p>)}<ol className="list-inside list-decimal text-sm text-slate-600">{campaign.groups.map((g, i) => <li key={i}>{g.group.name}</li>)}</ol></div>}
    </section>
    {total > 0 && <section className="rounded-xl border bg-white p-6"><h2 className="text-lg font-bold">{sent} de {total} {campaign.provider === 'simulator' ? 'simulados' : 'enviados'}</h2><progress aria-label="Progresso de envios" value={sent} max={total} className="mt-3 h-2 w-full accent-emerald-600" /><p className="mt-3 text-sm text-slate-500">{failed} falhas · {campaign.progress.CANCELLED ?? 0} cancelados · {campaign.progress.PENDING ?? 0} aguardando</p><p className="mt-2 text-sm">{campaign.status === 'PAUSED' ? 'Fila pausada. A ordem e os pendentes estão preservados.' : campaign.nextAt ? `Próximo envio: ${minutes ? `em aproximadamente ${minutes} min` : 'aguardando o processador/conexão'}.` : 'Nenhum envio restante.'}</p></section>}
    <section className="rounded-xl border bg-white p-6"><h2 className="text-lg font-bold">Visualizações por grupo — histórico</h2><p className="mt-2 font-semibold">Visualizações totais: {campaign.readsTotal}</p><p className="mt-2 text-sm text-slate-500">Total registrado desde a criação da campanha, inclusive após o encerramento; sem limite de 24 horas. Leituras confirmadas por recibos do WhatsApp. Cada destinatário conta uma vez por mensagem; pode contar novamente em outra mensagem. Ausência de recibos não significa ausência de leitura.</p><ul className="mt-4 divide-y">{campaign.readsByGroup.map(group => <li key={group.groupId} className="flex justify-between gap-4 py-3"><span>{group.name}</span><span>{group.count} visualizações</span></li>)}</ul></section>
    <section className="overflow-hidden rounded-xl border bg-white"><h2 className="p-6 text-lg font-bold">Histórico desta campanha</h2><p className="px-6 pb-2 text-sm text-slate-500">Horário de Brasília (America/Sao_Paulo).</p><p className="px-6 pb-4 text-sm text-slate-500">Leituras confirmadas contam destinatários distintos por mensagem, somente quando o WhatsApp fornece recibos. Sem recibos não significa ninguém leu. Falhas incertas não oferecem reenvio para evitar duplicatas.</p>
      <ul className="divide-y">{deliveries.map(d => <li key={d.id} className="p-4"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{d.sequence + 1}. {d.group.name}</span><span className={d.status === 'FAILED' ? 'text-red-700' : 'text-emerald-700'}>{d.status === 'SENT' && d.provider === 'simulator' ? 'Simulado ✓' : d.status === 'CANCELLED' ? 'Cancelado' : labels[d.status]}</span></div><p className="mt-1 text-sm text-slate-500">{d.sentAt ? `Enviado em ${new Date(d.sentAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : `Previsto a partir de ${new Date(d.scheduledAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`}{d.provider === 'baileys' && d.status === 'SENT' && ` · ${d._count.reads} leituras confirmadas`}</p>{d.error && <p className="mt-2 text-sm text-red-700">{d.error}</p>}</li>)}</ul>
      {!deliveries.length && <p className="p-6 text-slate-500">Os envios serão criados ao iniciar.</p>}<div className="flex justify-between p-4 text-sm text-emerald-700">{page > 0 && <Link to={`?page=${page - 1}`}>← Anteriores</Link>}{deliveries.length === 100 && <Link to={`?page=${page + 1}`}>Próximos →</Link>}</div>
    </section>
  </div></main>;
}
