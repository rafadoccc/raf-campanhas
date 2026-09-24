import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Badge, Card, EmptyState, LoadMoreSentinel, Page, PageHeader, ScrollArea, Skeleton, dataHora, deliveryStatus, useInfiniteList } from '../design';

type Delivery = {
  id: string; campaignId: string; status: string; provider: string; scheduledAt: string; sentAt: string | null; error: string | null;
  deliveredAt: string | null; serverRejectedAt: string | null; attempts: number;
  campaign: { name: string }; group: { name: string };
};

export default function HistoryPage() {
  const list = useInfiniteList<Delivery>(async (cursor, signal) => {
    const page = cursor ? Number(cursor) : 0;
    const items = await api<Delivery[]>(`/deliveries?page=${page}`, { signal });
    return { items, next: items.length === 100 ? String(page + 1) : null };
  }, []);

  return <Page className="overflow-hidden">
    <PageHeader title="Histórico" subtitle="Todos os envios, mais recentes primeiro · horário de Brasília" />
    {list.error && !list.items && <Alert tone="warning">Não foi possível carregar o histórico. Confira se o sistema está ligado.</Alert>}
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        {!list.items ? <div className="space-y-2 p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
          : list.items.length === 0 ? <EmptyState title="Nenhum envio ainda." />
          : <>
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-2xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2 font-medium">Grupo</th><th className="hidden px-4 py-2 font-medium md:table-cell">Campanha</th><th className="px-4 py-2 font-medium">Previsto</th><th className="px-4 py-2 font-medium">Situação</th><th className="hidden px-4 py-2 font-medium lg:table-cell">Detalhe</th></tr>
              </thead>
              <tbody className="divide-y divide-line">{list.items.map(d => {
                const status = deliveryStatus(d);
                return <tr key={d.id} className="align-top">
                  <td className="max-w-[16rem] truncate px-4 py-2 font-medium">{d.group.name}</td>
                  <td className="hidden max-w-[14rem] truncate px-4 py-2 text-muted md:table-cell"><Link to={`/campanhas/${d.campaignId}`} className="hover:underline">{d.campaign.name}</Link></td>
                  <td className="tabular whitespace-nowrap px-4 py-2">{dataHora(d.scheduledAt)}</td>
                  <td className="px-4 py-2"><Badge tone={status.tone} title={status.title}>{status.label}</Badge></td>
                  <td className="hidden max-w-[22rem] px-4 py-2 text-2xs text-muted lg:table-cell">{d.error ?? (d.sentAt ? `Saiu ${dataHora(d.sentAt)}` : '—')}</td>
                </tr>;
              })}</tbody>
            </table>
            <LoadMoreSentinel active={list.hasMore} onVisible={() => void list.loadMore()} />
            {list.loadingMore && <p className="py-3 text-center text-xs text-muted">Carregando mais…</p>}
          </>}
      </ScrollArea>
    </Card>
  </Page>;
}
