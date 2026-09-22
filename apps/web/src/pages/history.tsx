import { api } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import { card, dataHora, deliveryStatus, LoadError, PageHeader, page, Pill } from '../components/ui';

type Delivery = {
  id: string; status: string; provider: string; scheduledAt: string; sentAt: string | null; error: string | null;
  deliveredAt: string | null; serverRejectedAt: string | null; attempts: number;
  campaign: { name: string }; group: { name: string };
};

export default function HistoryPage() {
  const { data: deliveries, error, reload } = usePolling(signal => api<Delivery[]>('/deliveries', { signal }), []);
  return <main className={page}>
    <PageHeader title="Histórico" />
    <p className="-mt-4 mb-6 text-sm text-slate-500">Últimos 100 envios · horário de Brasília</p>
    <div className={`${card} overflow-hidden`}>
      {deliveries === null
        ? (error ? <LoadError what="o histórico" onRetry={reload} /> : <p className="p-6 text-slate-500">Carregando…</p>)
        : deliveries.length === 0
          ? <p className="p-6 text-slate-500">Nenhum envio ainda.</p>
          : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3">Grupo</th><th className="px-4 py-3">Campanha</th><th className="px-4 py-3">Previsto</th><th className="px-4 py-3">Situação</th><th className="px-4 py-3">Detalhe</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{deliveries.map(d => {
              const status = deliveryStatus(d);
              return <tr key={d.id}>
                <td className="px-4 py-3 font-medium">{d.group.name}</td>
                <td className="px-4 py-3 text-slate-600">{d.campaign.name}</td>
                <td className="whitespace-nowrap px-4 py-3">{dataHora(d.scheduledAt)}</td>
                <td className="px-4 py-3"><Pill tone={status.tone} title={status.title}>{status.label}</Pill></td>
                <td className="px-4 py-3 text-xs text-slate-500">{d.error ?? (d.sentAt ? `Saiu ${dataHora(d.sentAt)}` : '—')}</td>
              </tr>;
            })}</tbody>
          </table></div>}
    </div>
  </main>;
}
