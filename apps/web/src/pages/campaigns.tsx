import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage, api } from '../lib/api';
import { archiveCampaign, deleteCampaign, editAction, editCampaign } from '../lib/campaign-ops';
import {
  Alert, Button, ButtonLink, EmptyState, LoadMoreSentinel, Menu, Page, PageHeader, ScrollArea, Segmented, Skeleton,
  IconAdd, IconArchive, IconCampaigns, IconDelete, IconEdit, IconReschedule, IconReuse, IconSearch, IconTemplate, IconUnarchive, IconVideo, IconView,
  accent, campaignStatus, inputClass, useConfirm, useInfiniteList, type MenuItem,
} from '../design';
import { CampaignMeta } from '../components/campaign-meta';
import { TemplateList, saveAsTemplate } from '../components/templates';
import { usePlanPolling } from '../components/plan-notice';

type Campaign = {
  id: string; name: string; startsAt: string; endsAt: string; status: string; provider: string; createdAt: string; archivedAt: string | null;
  mode: string; groupCount: number; schedules: { time: string }[];
  media: { id: string; kind: string; color: string | null } | null;
  progress: Record<string, number>;
};

// Três listas (ADR-054): as campanhas em uso, as arquivadas (que o dono tirou da frente, com
// envios e relatório guardados) e os modelos (ADR-047). Dentro das duas primeiras, um filtro pela
// situação. Não existe mais "rascunho" na tela: campanha criada e ainda não iniciada é "não iniciada".
type View = 'ativas' | 'arquivadas' | 'modelos';
const VIEWS: readonly { label: string; value: View }[] = [{ label: 'Ativas', value: 'ativas' }, { label: 'Arquivadas', value: 'arquivadas' }, { label: 'Modelos', value: 'modelos' }];
const SITUATIONS: readonly { label: string; value: string }[] = [
  { label: 'Todas', value: '' },
  { label: 'Não iniciadas', value: 'DRAFT' },
  { label: 'Pendentes', value: 'ACTIVE,PAUSED' },
  { label: 'Concluídas', value: 'COMPLETED,CANCELLED' },
];
const editIcon = { edit: IconEdit, reuse: IconReuse, reschedule: IconReschedule } as const;
// Ponto da situação, na linha dos números (no lugar do selo que ficava no canto do cartão).
const statusDot: Record<string, string> = { DRAFT: 'bg-slate-300', ACTIVE: 'bg-brand-500', PAUSED: 'bg-amber-500', COMPLETED: 'bg-sky-500', CANCELLED: 'bg-slate-400' };

type CardProps = { campaign: Campaign; busy: boolean; onEdit: () => void; onDelete: () => void; onSaveTemplate: () => void; onArchive: (archived: boolean) => void };

function CampaignCard({ campaign, busy, onEdit, onDelete, onSaveTemplate, onArchive }: CardProps) {
  const status = campaignStatus[campaign.status] ?? campaignStatus.DRAFT;
  const color = accent(campaign.media?.color);
  const total = Object.values(campaign.progress).reduce((a, b) => a + b, 0);
  const sent = campaign.progress.SENT ?? 0;
  const failed = campaign.progress.FAILED ?? 0;
  const running = campaign.status === 'ACTIVE' || campaign.status === 'PAUSED';
  const archived = Boolean(campaign.archivedAt);
  const edit = editAction(campaign.status);
  const EditIcon = editIcon[edit.kind];
  const actions: MenuItem[] = [
    { label: 'Salvar como modelo', icon: IconTemplate, onSelect: onSaveTemplate },
    // Em andamento não arquiva: os envios dela não podem ficar escondidos.
    ...(archived ? [{ label: 'Desarquivar', icon: IconUnarchive, onSelect: () => onArchive(false) }]
      : running ? [] : [{ label: 'Arquivar', icon: IconArchive, onSelect: () => onArchive(true) }]),
    { label: 'Excluir', icon: IconDelete, danger: true, onSelect: onDelete },
  ];
  return <li className="flex min-w-0 flex-col rounded-lg border border-line bg-white p-4 shadow-card">
    <div className="flex items-start gap-3">
      {campaign.media?.kind === 'image'
        ? <img src={`/api/media/${campaign.media.id}/thumb`} alt="" loading="lazy" decoding="async" width={44} height={44} className="h-11 w-11 shrink-0 rounded object-cover" style={{ background: color.soft }} />
        : campaign.media?.kind === 'video'
          ? <div className="grid h-11 w-11 shrink-0 place-items-center rounded bg-slate-100 text-slate-400"><IconVideo className="h-5 w-5" aria-hidden /></div>
          : null}
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-semibold leading-tight" title={campaign.name}>{campaign.name}</h2>
        <div className="mt-1.5">
          <CampaignMeta groups={campaign.groupCount} mode={campaign.mode} schedules={campaign.schedules} startsAt={campaign.startsAt} endsAt={campaign.endsAt}
            status={campaign.status} simulated={campaign.status !== 'DRAFT' && campaign.provider === 'simulator'} />
        </div>
      </div>
      <Menu label={`Mais ações para ${campaign.name}`} items={actions} disabled={busy} />
    </div>

    {/* Situação e números numa linha só; a barra só enquanto a campanha anda. */}
    <div className="mt-3 space-y-1.5 border-t border-line pt-3">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink"><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${statusDot[campaign.status] ?? statusDot.DRAFT}`} />{status.label}</span>
        {total > 0 && <span className="tabular text-muted">{sent} de {total} enviados</span>}
        {failed > 0 && <span className="tabular text-red-700">{failed} {failed === 1 ? 'falha' : 'falhas'}</span>}
      </p>
      {running && total > 0 && <div className="h-1 overflow-hidden rounded-sm bg-slate-100"><div className="h-full transition-[width] duration-500 ease-out" style={{ width: `${(sent / total) * 100}%`, background: color.solid }} /></div>}
    </div>

    <div className="mt-auto flex items-center gap-1.5 pt-3">
      <ButtonLink to={`/campanhas/${campaign.id}`} variant="primary" size="sm" icon={IconView}>Ver</ButtonLink>
      <Button size="sm" icon={EditIcon} title={edit.title} onClick={onEdit} disabled={busy}>{edit.label}</Button>
    </div>
  </li>;
}

function CampaignList({ archived, situation, query, onNotice, onCountChanged }: { archived: boolean; situation: string; query: string; onNotice: (notice: Notice) => void; onCountChanged: () => void }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const list = useInfiniteList<Campaign>(async (cursor, signal) => {
    const params = new URLSearchParams({ limit: '24', ...(archived ? { archived: '1' } : {}), ...(cursor ? { cursor } : {}), ...(situation ? { status: situation } : {}), ...(query ? { q: query } : {}) });
    const page = await api<{ items: Campaign[]; nextCursor: string | null }>(`/campaigns?${params}`, { signal });
    return { items: page.items, next: page.nextCursor };
  }, [archived, situation, query], 15_000, `campanhas:${archived ? 'arquivadas' : 'ativas'}:${situation}:${query}`);

  async function run(campaign: Campaign, action: () => Promise<void>) {
    setBusy(campaign.id); setActionError('');
    try { await action(); } catch (e) { setActionError(errorMessage(e, 'Não foi possível concluir a ação.')); }
    finally { setBusy(null); }
  }
  const filtered = Boolean(query || situation);
  const empty = filtered ? { title: 'Nenhuma campanha com esse filtro.', hint: 'Troque o filtro ou a busca.' }
    : archived ? { title: 'Nenhuma campanha arquivada.', hint: 'Quando não for mais usar uma campanha, arquive pelo menu do cartão. Ela fica guardada aqui, com os envios e o relatório.' }
      : { title: 'Nenhuma campanha ainda.', hint: 'Crie a primeira em Nova campanha, no alto da tela.' };

  return <>
    {actionError && <Alert>{actionError}</Alert>}
    {list.error && !list.items && <Alert tone="warning">Não foi possível carregar as campanhas. Confira se o sistema está ligado.</Alert>}
    <ScrollArea className="-mx-1 flex-1 px-1 pb-4">
      {!list.items ? <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <li key={i}><Skeleton className="h-40" /></li>)}</ul>
        : list.items.length === 0 ? <EmptyState icon={archived ? IconArchive : IconCampaigns} title={empty.title} hint={empty.hint} />
        : <>
          <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{list.items.map(campaign => <CampaignCard key={campaign.id} campaign={campaign} busy={busy === campaign.id}
            onEdit={() => run(campaign, async () => { const id = await editCampaign(campaign, confirm); if (id) navigate(`/campanhas/${id}/editar`); })}
            onSaveTemplate={() => run(campaign, async () => { onNotice({ kind: 'template', name: (await saveAsTemplate(campaign.id)).name }); })}
            onArchive={next => run(campaign, async () => { await archiveCampaign(campaign.id, next); list.remove(campaign.id); onCountChanged(); onNotice({ kind: next ? 'archived' : 'restored', name: campaign.name }); })}
            onDelete={() => run(campaign, async () => { if (await deleteCampaign(campaign, confirm)) { list.remove(campaign.id); onCountChanged(); } })} />)}</ul>
          <LoadMoreSentinel active={list.hasMore} onVisible={() => void list.loadMore()} />
          {list.loadingMore && <p className="py-4 text-center text-xs text-muted">Carregando mais…</p>}
        </>}
    </ScrollArea>
  </>;
}

type Notice = { kind: 'template' | 'archived' | 'restored'; name: string };

export default function CampaignsPage() {
  // ?aba=modelos e ?aba=arquivadas abrem direto na lista (o formulário volta para os modelos ao salvar um).
  const [params, setParams] = useSearchParams();
  const [view, setViewState] = useState<View>(() => VIEWS.find(v => v.value === params.get('aba'))?.value ?? 'ativas');
  const [situation, setSituation] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  // Uso do limite de campanhas da conta (ADR-054); administrador não tem limite.
  const { data: plan, reload: reloadPlan } = usePlanPolling();
  const setView = (value: View) => {
    setViewState(value); setNotice(null);
    setParams(value === 'ativas' ? {} : { aba: value }, { replace: true });
  };
  const go = (value: View, label: string) => <button type="button" className="font-medium underline" onClick={() => setView(value)}>{label}</button>;

  return <Page className="lg:overflow-hidden">
    <PageHeader title="Campanhas" subtitle={plan?.maxCampaigns != null ? <span className="tabular">{plan.campaigns} de {plan.maxCampaigns} campanhas em uso · arquivadas e modelos não contam</span> : undefined} action={<ButtonLink to="/nova-campanha" variant="primary" icon={IconAdd}>Nova campanha</ButtonLink>} />
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="Lista de campanhas" value={view} onChange={setView} options={VIEWS} />
      {view !== 'modelos' && <>
        <Segmented label="Filtrar pela situação" value={situation} onChange={setSituation} options={SITUATIONS} />
        <form className="relative ml-auto w-full sm:w-56" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); }}>
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input type="search" value={search} onChange={event => { setSearch(event.target.value); if (!event.target.value) setQuery(''); }} placeholder="Buscar pelo nome…" aria-label="Buscar campanha pelo nome" className={`${inputClass} pl-8`} />
        </form>
      </>}
    </div>
    {notice?.kind === 'template' && <Alert tone="brand">Modelo "{notice.name}" salvo. {go('modelos', 'Ver modelos')}</Alert>}
    {notice?.kind === 'archived' && <Alert tone="brand">"{notice.name}" foi arquivada. {go('arquivadas', 'Ver arquivadas')}</Alert>}
    {notice?.kind === 'restored' && <Alert tone="brand">"{notice.name}" voltou para as ativas. {go('ativas', 'Ver ativas')}</Alert>}
    {view === 'modelos'
      ? <ScrollArea className="-mx-1 flex-1 px-1 pb-4"><TemplateList /></ScrollArea>
      : <CampaignList key={view} archived={view === 'arquivadas'} situation={situation} query={query} onNotice={setNotice} onCountChanged={reloadPlan} />}
  </Page>;
}
