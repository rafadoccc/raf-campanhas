import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { deleteCampaign, editAction, editCampaign } from '../lib/campaign-ops';
import {
  Alert, Badge, Button, ButtonLink, EmptyState, IconButton, LoadMoreSentinel, Page, PageHeader, ScrollArea, Segmented, Skeleton,
  IconAdd, IconCampaigns, IconDelete, IconEdit, IconReschedule, IconReuse, IconSearch, IconTemplate, IconVideo, IconView,
  accent, campaignStatus, inputClass, useConfirm, useInfiniteList,
} from '../design';
import { CampaignMeta } from '../components/campaign-meta';
import { TemplateList, saveAsTemplate } from '../components/templates';

type Campaign = {
  id: string; name: string; startsAt: string; endsAt: string; status: string; provider: string; createdAt: string;
  mode: string; mentionAll: boolean; groupCount: number; schedules: { time: string }[];
  media: { id: string; kind: string; color: string | null } | null;
  progress: Record<string, number>;
};

// "Modelos" (ADR-047) é uma aba à parte: mostra os modelos guardados, não campanhas filtradas.
const TEMPLATES = 'modelos';
const filters: { label: string; value: string }[] = [
  { label: 'Todas', value: '' },
  { label: 'Ativas', value: 'ACTIVE,PAUSED' },
  { label: 'Rascunhos', value: 'DRAFT' },
  { label: 'Concluídas', value: 'COMPLETED,CANCELLED' },
  { label: 'Modelos', value: TEMPLATES },
];
const editIcon = { edit: IconEdit, reuse: IconReuse, reschedule: IconReschedule } as const;

function CampaignCard({ campaign, onEdit, onDelete, onSaveTemplate, busy }: { campaign: Campaign; onEdit: () => void; onDelete: () => void; onSaveTemplate: () => void; busy: boolean }) {
  const status = campaignStatus[campaign.status] ?? campaignStatus.DRAFT;
  const color = accent(campaign.media?.color);
  const total = Object.values(campaign.progress).reduce((a, b) => a + b, 0);
  const sent = campaign.progress.SENT ?? 0;
  const failed = campaign.progress.FAILED ?? 0;
  const edit = editAction(campaign.status);
  const EditIcon = editIcon[edit.kind];
  return <li className="flex min-w-0 rounded-lg border border-line bg-white shadow-card">
    <div className="flex min-w-0 flex-1 flex-col p-4">
      <div className="flex items-start gap-3">
        {campaign.media?.kind === 'image'
          ? <img src={`/api/media/${campaign.media.id}/thumb`} alt="" loading="lazy" decoding="async" width={48} height={48} className="h-12 w-12 shrink-0 rounded object-cover" style={{ background: color.soft }} />
          : campaign.media?.kind === 'video'
            ? <div className="grid h-12 w-12 shrink-0 place-items-center rounded bg-slate-100 text-slate-400"><IconVideo className="h-5 w-5" aria-hidden /></div>
            : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate font-semibold" title={campaign.name}>{campaign.name}</h2>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <div className="mt-1.5">
            <CampaignMeta groups={campaign.groupCount} mode={campaign.mode} schedules={campaign.schedules} startsAt={campaign.startsAt} endsAt={campaign.endsAt}
              mentionAll={campaign.mentionAll} status={campaign.status} simulated={campaign.status !== 'DRAFT' && campaign.provider === 'simulator'} />
          </div>
        </div>
      </div>
      {total > 0 && <div className="mt-3">
        <div className="flex justify-between text-2xs text-muted"><span className="tabular">{sent} de {total} enviados</span>{failed > 0 && <span className="text-red-700">{failed} {failed === 1 ? 'falha' : 'falhas'}</span>}</div>
        <div className="mt-1 h-1 overflow-hidden rounded-sm bg-slate-100"><div className="h-full transition-[width] duration-500 ease-out" style={{ width: `${(sent / total) * 100}%`, background: color.solid }} /></div>
      </div>}
      <div className="mt-auto flex items-center gap-1.5 pt-4">
        <ButtonLink to={`/campanhas/${campaign.id}`} variant="primary" size="sm" icon={IconView}>Ver</ButtonLink>
        <Button size="sm" icon={EditIcon} title={edit.title} onClick={onEdit} disabled={busy}>{edit.label}</Button>
        <span className="ml-auto flex items-center gap-1">
          <IconButton icon={IconTemplate} label="Salvar como modelo" onClick={onSaveTemplate} disabled={busy} />
          <IconButton icon={IconDelete} label="Excluir" variant="danger" onClick={onDelete} disabled={busy} />
        </span>
      </div>
    </div>
  </li>;
}

function CampaignList({ filter, query, onSavedTemplate }: { filter: string; query: string; onSavedTemplate: (name: string) => void }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const list = useInfiniteList<Campaign>(async (cursor, signal) => {
    const params = new URLSearchParams({ limit: '24', ...(cursor ? { cursor } : {}), ...(filter ? { status: filter } : {}), ...(query ? { q: query } : {}) });
    const page = await api<{ items: Campaign[]; nextCursor: string | null }>(`/campaigns?${params}`, { signal });
    return { items: page.items, next: page.nextCursor };
  }, [filter, query], 15_000, `campanhas:${filter}:${query}`);

  async function run(campaign: Campaign, action: () => Promise<void>) {
    setBusy(campaign.id); setActionError('');
    try { await action(); } catch (e) { setActionError(errorMessage(e, 'Não foi possível concluir a ação.')); }
    finally { setBusy(null); }
  }

  return <>
    {actionError && <Alert>{actionError}</Alert>}
    {list.error && !list.items && <Alert tone="warning">Não foi possível carregar as campanhas. Confira se o sistema está ligado.</Alert>}
    <ScrollArea className="-mx-1 flex-1 px-1 pb-4">
      {!list.items ? <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <li key={i}><Skeleton className="h-40" /></li>)}</ul>
        : list.items.length === 0 ? <EmptyState icon={IconCampaigns} title={query || filter ? 'Nenhuma campanha com esse filtro.' : 'Nenhuma campanha ainda.'}
          hint={query || filter ? 'Troque o filtro ou a busca.' : 'Crie a primeira em Nova campanha, no alto da tela.'} />
        : <>
          <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{list.items.map(campaign => <CampaignCard key={campaign.id} campaign={campaign} busy={busy === campaign.id}
            onEdit={() => run(campaign, async () => { const id = await editCampaign(campaign, confirm); if (id) navigate(`/campanhas/${id}/editar`); })}
            onSaveTemplate={() => run(campaign, async () => { onSavedTemplate((await saveAsTemplate(campaign.id)).name); })}
            onDelete={() => run(campaign, async () => { if (await deleteCampaign(campaign, confirm)) list.remove(campaign.id); })} />)}</ul>
          <LoadMoreSentinel active={list.hasMore} onVisible={() => void list.loadMore()} />
          {list.loadingMore && <p className="py-4 text-center text-xs text-muted">Carregando mais…</p>}
        </>}
    </ScrollArea>
  </>;
}

export default function CampaignsPage() {
  // ?aba=modelos abre direto nos modelos (é para onde o formulário volta ao salvar um modelo).
  const [params, setParams] = useSearchParams();
  const [filter, setFilterState] = useState(() => (params.get('aba') === TEMPLATES ? TEMPLATES : ''));
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [savedTemplate, setSavedTemplate] = useState('');
  const templates = filter === TEMPLATES;
  const setFilter = (value: string) => {
    setFilterState(value); setSavedTemplate('');
    setParams(value === TEMPLATES ? { aba: TEMPLATES } : {}, { replace: true });
  };

  return <Page className="lg:overflow-hidden">
    <PageHeader title="Campanhas" action={<ButtonLink to="/nova-campanha" variant="primary" icon={IconAdd}>Nova campanha</ButtonLink>} />
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="Filtrar campanhas" value={filter} onChange={setFilter} options={filters} />
      {!templates && <form className="relative ml-auto w-full sm:w-64" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); }}>
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input type="search" value={search} onChange={event => { setSearch(event.target.value); if (!event.target.value) setQuery(''); }} placeholder="Buscar pelo nome…" aria-label="Buscar campanha pelo nome" className={`${inputClass} pl-8`} />
      </form>}
    </div>
    {savedTemplate && <Alert tone="brand">Modelo "{savedTemplate}" salvo. <button type="button" className="font-medium underline" onClick={() => setFilter(TEMPLATES)}>Ver modelos</button></Alert>}
    {templates
      ? <ScrollArea className="-mx-1 flex-1 px-1 pb-4"><TemplateList /></ScrollArea>
      : <CampaignList filter={filter} query={query} onSavedTemplate={setSavedTemplate} />}
  </Page>;
}
