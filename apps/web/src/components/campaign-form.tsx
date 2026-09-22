import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { ServerClock } from './server-clock';
import { CampaignMediaInput, type CampaignMedia } from './campaign-media';
import { card, membros, page, primaryButton } from './ui';

type Group = { id: string; name: string; active: boolean; externalId: string | null; adminOnly: boolean | null; isAdmin: boolean | null; participants: number | null };
// Selo "só admins": diz também se a conta conectada é admin, para não precisar conferir no celular.
function adminBadge(group: Group) {
  if (!group.adminOnly) return null;
  if (group.isAdmin) return { text: 'Só admins · você é admin ✓', tone: 'bg-emerald-50 text-emerald-800' };
  if (group.isAdmin === false) return { text: 'Só admins · você não é admin', tone: 'bg-red-50 text-red-700' };
  return { text: 'Só admins · não confirmado', tone: 'bg-amber-50 text-amber-800' };
}
function GroupLabel({ group }: { group: Group }) {
  const badge = adminBadge(group);
  return <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <span>{group.name}{!group.externalId && ' (simulação)'}</span>
    {membros(group.participants) && <span className="text-xs text-slate-400">{membros(group.participants)}</span>}
    {badge && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.tone}`}>{badge.text}</span>}
  </span>;
}
type CampaignDraft = { status: string; name: string; startsAt: string; endsAt: string; mode: string; intervalSeconds: number; media: CampaignMedia | null; messages: { content: string }[]; groups: { groupId: string }[]; schedules: { time: string }[] };
const field = 'mt-1 w-full rounded-lg border border-slate-300 p-2';
const label = 'block text-sm font-medium';
// Busca sem acento e sem diferenciar maiúsculas: "sao paulo" encontra "São Paulo".
const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const panel = `${card} space-y-4 p-6`;

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
      setInitial({ name: data.name, startsAt: data.startsAt.slice(0, 10), endsAt: data.endsAt.slice(0, 10), messages: data.messages.map((m: { content: string }) => m.content) });
      setSelected(data.groups.map((g: { groupId: string }) => g.groupId)); setMode(data.mode); setIntervalValue(data.intervalSeconds / 60);
      setTimes(data.schedules.length ? data.schedules.map((s: { time: string }) => s.time) : ['09:00']); setLoaded(true);
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

  return <main className={page}><form onSubmit={submit} className="mx-auto max-w-3xl space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-2"><h1 className="text-2xl font-bold">{campaignId ? 'Editar campanha' : 'Nova campanha'}</h1><ServerClock /></header>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {!loaded && <p className="text-slate-500">Carregando…</p>}
    {loaded && <>
      <section className={panel}>
        <label className={label}>Nome<input defaultValue={initial.name} required maxLength={200} name="name" className={field} placeholder="Ex.: Festival de Inverno" /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}>Quando enviar<select value={mode} onChange={e => setMode(e.target.value)} className={field}><option value="IMMEDIATE">Ao iniciar (fila única)</option><option value="SCHEDULED">Em horários diários</option></select></label>
          <label className={label}>Intervalo entre grupos (min)<input type="number" required min={1} max={60} step={1} value={interval} onChange={e => setIntervalValue(Number(e.target.value))} className={field} /></label>
        </div>
        {mode === 'SCHEDULED' && <>
          <div className="grid gap-4 sm:grid-cols-2"><label className={label}>De<input defaultValue={initial.startsAt} required name="startsAt" type="date" className={field} /></label><label className={label}>Até<input defaultValue={initial.endsAt} required name="endsAt" type="date" className={field} /></label></div>
          <div className="flex flex-wrap items-center gap-2">
            {times.map((time, i) => <span key={i} className="flex items-center gap-1"><input aria-label={`Horário ${i + 1}`} required type="time" value={time} onChange={e => setTimes(current => current.map((t, n) => n === i ? e.target.value : t))} className="rounded-lg border border-slate-300 p-2" />{times.length > 1 && <button type="button" aria-label={`Remover horário ${i + 1}`} onClick={() => setTimes(current => current.filter((_, n) => n !== i))} className="px-1 text-slate-400 hover:text-red-700">×</button>}</span>)}
            <button type="button" disabled={times.length >= 24} onClick={() => setTimes(current => [...current, '18:00'])} className="text-sm text-emerald-700">+ horário</button>
          </div>
        </>}
      </section>

      <section className={panel}>
        <h2 className="font-semibold">Grupos</h2>
        {!groupsLoaded && <p className="text-sm text-slate-500">Carregando grupos…</p>}
        {groupsLoaded && !groups.length && <Link to="/configuracoes" className="text-sm text-emerald-700">Conectar e sincronizar grupos →</Link>}
        {!!groups.length && <div className="space-y-2">
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} placeholder="Buscar grupo…" aria-label="Buscar grupo pelo nome" className={field} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
            <span>{term ? `${visible.length} de ${groups.length}` : `${groups.length} grupos`} · {selected.length} selecionados</span>
            <span className="flex gap-3">
              <button type="button" onClick={selectVisible} disabled={!visible.some(group => !selected.includes(group.id))} className="text-emerald-700 disabled:opacity-40">{term ? 'Selecionar exibidos' : 'Selecionar todos'}</button>
              <button type="button" onClick={() => setSelected([])} disabled={!selected.length} className="disabled:opacity-40">Limpar</button>
            </span>
          </div>
        </div>}
        <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">{visible.map(group => <label key={group.id} className="flex items-start gap-2 py-1.5 text-sm"><input type="checkbox" className="mt-1" checked={selected.includes(group.id)} onChange={() => toggle(group.id)} /><GroupLabel group={group} /></label>)}</div>
        {!!groups.length && !visible.length && <p className="text-sm text-slate-500">Nenhum grupo com “{search.trim()}”.</p>}
        {blocked > 0 && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{blocked === 1 ? '1 grupo selecionado só aceita mensagens de admins e você não é admin: ele não vai receber.' : `${blocked} grupos selecionados só aceitam mensagens de admins e você não é admin: eles não vão receber.`}</p>}
        {!!selected.length && <div className="border-t pt-3">
          <p className="mb-2 text-xs font-medium text-slate-500">Ordem de envio</p>
          <ol className="space-y-1.5">{selected.map((id, i) => <li key={id} className="flex items-center gap-2 text-sm">
            <span className="w-6 text-right text-slate-400">{i + 1}.</span>
            <span className="flex-1">{byId(id) ? <GroupLabel group={byId(id)!} /> : 'Grupo indisponível'}</span>
            <button type="button" aria-label={`Subir grupo ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded border px-2 disabled:opacity-30">↑</button>
            <button type="button" aria-label={`Descer grupo ${i + 1}`} disabled={i === selected.length - 1} onClick={() => move(i, 1)} className="rounded border px-2 disabled:opacity-30">↓</button>
            <button type="button" aria-label={`Remover grupo ${i + 1}`} onClick={() => toggle(id)} className="rounded border px-2 text-red-700">×</button>
          </li>)}</ol>
        </div>}
      </section>

      <section className={panel}>
        {initial.messages.map((message, i) => <label key={i} className={label}>Mensagem{initial.messages.length > 1 ? ` ${i + 1}` : ''}<textarea defaultValue={message} required maxLength={10000} name="message" className={`${field} min-h-28`} /></label>)}
      </section>
      <CampaignMediaInput value={media} onChange={setMedia} disabled={saving} />

      <div className="flex flex-wrap items-center gap-4">
        <button disabled={saving || !selected.length} className={primaryButton}>{saving ? 'Salvando…' : 'Salvar campanha'}</button>
        {!!selected.length && <span className="text-sm text-slate-500">{selected.length} grupos · ~{Math.max(0, selected.length - 1) * interval} min por rodada</span>}
        {campaignId && <Link className="ml-auto text-sm text-slate-500" to={`/campanhas/${campaignId}`}>Cancelar</Link>}
      </div>
    </>}
  </form></main>;
}
