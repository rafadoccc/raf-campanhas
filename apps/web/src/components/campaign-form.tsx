import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { ServerClock } from './server-clock';
import { CampaignMediaInput, type CampaignMedia } from './campaign-media';
import {
  Alert, Button, Card, Field, IconButton, Page, PageHeader, ScrollArea,
  IconAdd, IconBack, IconMoveDown, IconMoveUp, IconRemove, IconSearch,
  buttonClass, inputClass, membros,
} from '../design';

type Group = { id: string; name: string; active: boolean; externalId: string | null; adminOnly: boolean | null; isAdmin: boolean | null; participants: number | null };
type CampaignDraft = { status: string; name: string; startsAt: string; endsAt: string; mode: string; intervalSeconds: number; media: CampaignMedia | null; messages: { content: string }[]; groups: { groupId: string }[]; schedules: { time: string }[] };

// Selo "só admins": diz também se a conta conectada é admin, para não precisar conferir no celular.
function adminBadge(group: Group) {
  if (!group.adminOnly) return null;
  if (group.isAdmin) return { text: 'Só admins · você é admin', tone: 'bg-brand-50 text-brand-700' };
  if (group.isAdmin === false) return { text: 'Só admins · você não é admin', tone: 'bg-red-50 text-red-700' };
  return { text: 'Só admins · não confirmado', tone: 'bg-amber-50 text-amber-800' };
}
function GroupLabel({ group }: { group: Group }) {
  const badge = adminBadge(group);
  return <span className="min-w-0">
    <span className="block truncate" title={group.name}>{group.name}{!group.externalId && ' (simulação)'}</span>
    <span className="flex flex-wrap items-center gap-x-2 text-2xs text-slate-400">
      {membros(group.participants)}
      {badge && <span className={`rounded-sm px-1 font-medium ${badge.tone}`}>{badge.text}</span>}
    </span>
  </span>;
}
// Busca sem acento e sem diferenciar maiúsculas: "sao paulo" encontra "São Paulo".
const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export default function CampaignForm({ campaignId }: { campaignId?: string }) {
  const navigate = useNavigate();
  const [media, setMedia] = useState<CampaignMedia | null>(null);
  const [groups, setGroups] = useState<Group[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState('IMMEDIATE'); const [interval, setIntervalValue] = useState(3);
  const [times, setTimes] = useState(['09:00']); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!campaignId);
  const [search, setSearch] = useState('');
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const term = normalize(search);
  const visible = term ? groups.filter(group => normalize(group.name).includes(term)) : groups;
  const byId = (id: string) => groups.find(g => g.id === id);
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const selectVisible = () => setSelected(current => [...current, ...visible.map(group => group.id).filter(id => !current.includes(id))]);
  const blocked = selected.filter(id => byId(id)?.adminOnly && byId(id)?.isAdmin === false).length;
  const [initial, setInitial] = useState({ name: '', startsAt: '', endsAt: '', messages: [''] });
  useEffect(() => {
    if (!campaignId) return;
    api<CampaignDraft>(`/campaigns/${campaignId}`).then(data => {
      if (data.status !== 'DRAFT') throw Error('Somente rascunhos podem ser editados.');
      setMedia(data.media ?? null);
      setInitial({ name: data.name, startsAt: data.startsAt.slice(0, 10), endsAt: data.endsAt.slice(0, 10), messages: data.messages.map(m => m.content) });
      setSelected(data.groups.map(g => g.groupId)); setMode(data.mode); setIntervalValue(data.intervalSeconds / 60);
      setTimes(data.schedules.length ? data.schedules.map(s => s.time) : ['09:00']); setLoaded(true);
    }).catch(e => setError(e instanceof Error ? e.message : 'Não foi possível carregar a campanha.'));
  }, [campaignId]);
  useEffect(() => { api<Group[]>('/groups').then(data => { setGroups(data.filter(g => g.active)); setGroupsLoaded(true); }).catch(() => setError('Não foi possível carregar os grupos.')); }, []);
  function move(index: number, delta: number) { setSelected(current => { const copy = [...current]; [copy[index], copy[index + delta]] = [copy[index + delta], copy[index]]; return copy; }); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); const form = new FormData(event.currentTarget);
    try {
      let mediaId = media?.id ?? null;
      if (media?.file) {
        const result = await api<CampaignMedia & { id: string }>(`/media?name=${encodeURIComponent(media.name)}`, { method: 'POST', headers: { 'Content-Type': media.mimeType }, body: media.file });
        mediaId = result.id; setMedia(result);
      }
      const data = await api<{ id: string }>(`/campaigns${campaignId ? `/${campaignId}` : ''}`, { method: campaignId ? 'PATCH' : 'POST', json: { mediaId, name: form.get('name'), mode, intervalSeconds: interval * 60, startsAt: form.get('startsAt'), endsAt: form.get('endsAt'), groupIds: selected, messages: form.getAll('message'), times: mode === 'SCHEDULED' ? times : [] } });
      navigate(`/campanhas/${data.id}`);
    } catch (e) { setError(errorMessage(e, 'Não foi possível salvar a campanha.')); } finally { setSaving(false); }
  }

  return <Page>
    <Link to={campaignId ? `/campanhas/${campaignId}` : '/campanhas'} className="inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-ink"><IconBack className="h-3.5 w-3.5" aria-hidden />{campaignId ? 'Voltar sem salvar' : 'Campanhas'}</Link>
    <form onSubmit={submit} className="mx-auto w-full max-w-4xl space-y-4 pb-6">
      <PageHeader title={campaignId ? 'Editar campanha' : 'Nova campanha'} subtitle={<ServerClock />} />
      {error && <Alert>{error}</Alert>}
      {!loaded && <p className="text-muted">Carregando…</p>}
      {loaded && <>
        <Card className="space-y-4 p-4">
          <Field label="Nome"><input defaultValue={initial.name} required maxLength={200} name="name" className={inputClass} placeholder="Ex.: Festival de Inverno" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quando enviar"><select value={mode} onChange={e => setMode(e.target.value)} className={inputClass}><option value="IMMEDIATE">Ao iniciar (fila única)</option><option value="SCHEDULED">Em horários diários</option></select></Field>
            <Field label="Intervalo entre grupos (min)"><input type="number" required min={1} max={60} step={1} value={interval} onChange={e => setIntervalValue(Number(e.target.value))} className={inputClass} /></Field>
          </div>
          {mode === 'SCHEDULED' && <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="De"><input defaultValue={initial.startsAt} required name="startsAt" type="date" className={inputClass} /></Field>
              <Field label="Até"><input defaultValue={initial.endsAt} required name="endsAt" type="date" className={inputClass} /></Field>
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-muted">Horários</span>
              <div className="flex flex-wrap items-center gap-2">
                {times.map((time, i) => <span key={i} className="flex items-center gap-1">
                  <input aria-label={`Horário ${i + 1}`} required type="time" value={time} onChange={e => setTimes(current => current.map((t, n) => n === i ? e.target.value : t))} className={`${inputClass} !w-auto`} />
                  {times.length > 1 && <IconButton icon={IconRemove} label={`Remover horário ${i + 1}`} onClick={() => setTimes(current => current.filter((_, n) => n !== i))} />}
                </span>)}
                <Button size="sm" variant="ghost" icon={IconAdd} disabled={times.length >= 24} onClick={() => setTimes(current => [...current, '18:00'])}>Horário</Button>
              </div>
            </div>
          </>}
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Grupos</h2>
            <span className="text-xs text-muted">{term ? `${visible.length} de ${groups.length}` : `${groups.length} grupos`} · <strong className="text-ink">{selected.length}</strong> selecionados</span>
          </div>
          {!groupsLoaded && <p className="text-sm text-muted">Carregando grupos…</p>}
          {groupsLoaded && !groups.length && <Link to="/configuracoes" className={buttonClass('primary', 'sm')}>Conectar e sincronizar grupos</Link>}
          {!!groups.length && <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <input type="search" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} placeholder="Buscar grupo…" aria-label="Buscar grupo pelo nome" className={`${inputClass} pl-8`} />
            </div>
            <Button size="sm" onClick={selectVisible} disabled={!visible.some(group => !selected.includes(group.id))}>{term ? 'Selecionar exibidos' : 'Selecionar todos'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])} disabled={!selected.length}>Limpar</Button>
          </div>}
          {/* Duas colunas: mais grupos à vista de uma vez. */}
          <ScrollArea className="max-h-80 rounded border border-line">
            <ul className="grid sm:grid-cols-2">{visible.map(group => <li key={group.id} className="border-b border-line sm:odd:border-r">
              <label className={`flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-slate-50 ${selected.includes(group.id) ? 'bg-brand-50/60' : ''}`}>
                <input type="checkbox" className="mt-0.5 accent-brand-600" checked={selected.includes(group.id)} onChange={() => toggle(group.id)} />
                <GroupLabel group={group} />
              </label>
            </li>)}</ul>
            {!!groups.length && !visible.length && <p className="p-4 text-sm text-muted">Nenhum grupo com “{search.trim()}”.</p>}
          </ScrollArea>
          {blocked > 0 && <Alert>{blocked === 1 ? '1 grupo selecionado só aceita mensagens de admins e você não é admin: ele não vai receber.' : `${blocked} grupos selecionados só aceitam mensagens de admins e você não é admin: eles não vão receber.`}</Alert>}
          {!!selected.length && <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Ordem de envio</p>
            <ScrollArea className="max-h-72 rounded border border-line">
              <ol className="divide-y divide-line">{selected.map((id, i) => <li key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="tabular w-6 shrink-0 text-right text-xs text-slate-400">{i + 1}</span>
                <span className="min-w-0 flex-1">{byId(id) ? <GroupLabel group={byId(id)!} /> : 'Grupo indisponível'}</span>
                <IconButton icon={IconMoveUp} label={`Subir grupo ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon={IconMoveDown} label={`Descer grupo ${i + 1}`} disabled={i === selected.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon={IconRemove} label={`Remover grupo ${i + 1}`} variant="danger" onClick={() => toggle(id)} />
              </li>)}</ol>
            </ScrollArea>
          </div>}
        </Card>

        <Card className="space-y-3 p-4">
          {initial.messages.map((message, i) => <Field key={i} label={`Mensagem${initial.messages.length > 1 ? ` ${i + 1}` : ''}`}><textarea defaultValue={message} required maxLength={10000} name="message" className={`${inputClass} min-h-28`} /></Field>)}
        </Card>
        <CampaignMediaInput value={media} onChange={setMedia} disabled={saving} />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={saving} disabled={saving || !selected.length}>{saving ? 'Salvando…' : 'Salvar campanha'}</Button>
          {!!selected.length && <span className="text-xs text-muted">{selected.length} grupos · ~{Math.max(0, selected.length - 1) * interval} min por rodada</span>}
        </div>
      </>}
    </form>
  </Page>;
}
