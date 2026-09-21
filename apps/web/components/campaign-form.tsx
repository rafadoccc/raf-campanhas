'use client';
import { API_URL } from './api-url';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ServerClock } from './server-clock';
import { CampaignMediaInput, type CampaignMedia } from './campaign-media';
type Group = { id: string; name: string; active: boolean; externalId: string | null };
const api = API_URL;
const field = 'mt-1 w-full rounded-lg border border-slate-300 p-2';
// Busca sem acento e sem diferenciar maiúsculas: "sao paulo" encontra "São Paulo".
const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const panel = 'space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm';
export default function CampaignForm({ campaignId }: { campaignId?: string }) {
  const router = useRouter();
  const [media, setMedia] = useState<CampaignMedia | null>(null);
  const [groups, setGroups] = useState<Group[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState('IMMEDIATE'); const [interval, setIntervalValue] = useState(3);
  const [times, setTimes] = useState(['09:00']); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!campaignId);
  const [search, setSearch] = useState('');
  const term = normalize(search);
  const visible = term ? groups.filter(group => normalize(group.name).includes(term)) : groups;
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const selectVisible = () => setSelected(current => [...current, ...visible.map(group => group.id).filter(id => !current.includes(id))]);
  const [initial, setInitial] = useState({ name: '', startsAt: '', endsAt: '', messages: [''] });
  useEffect(() => {
    if (!campaignId) return;
    fetch(`${api}/campaigns/${campaignId}`).then(async r => { const data = await r.json(); if (!r.ok) throw Error(data.error); return data; }).then(data => {
      if (data.status !== 'DRAFT') throw Error('Somente rascunhos podem ser editados.');
      setMedia(data.media ?? null);
      setInitial({ name: data.name, startsAt: data.startsAt.slice(0, 10), endsAt: data.endsAt.slice(0, 10), messages: data.messages.map((m: { content: string }) => m.content) });
      setSelected(data.groups.map((g: { groupId: string }) => g.groupId)); setMode(data.mode); setIntervalValue(data.intervalSeconds / 60);
      setTimes(data.schedules.length ? data.schedules.map((s: { time: string }) => s.time) : ['09:00']); setLoaded(true);
    }).catch(e => setError(e instanceof Error ? e.message : 'Não foi possível carregar a campanha.'));
  }, [campaignId]);
  useEffect(() => { fetch(`${api}/groups`).then(async r => { if (!r.ok) throw Error(); return r.json(); }).then((data: Group[]) => setGroups(data.filter(g => g.active))).catch(() => setError('Não foi possível carregar os grupos.')); }, []);
  function move(index: number, delta: number) { setSelected(current => { const copy = [...current]; [copy[index], copy[index + delta]] = [copy[index + delta], copy[index]]; return copy; }); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); const form = new FormData(event.currentTarget);
    try {
      let mediaId = media?.id ?? null;
      if (media?.file) {
        const upload = await fetch(`${api}/media?name=${encodeURIComponent(media.name)}`, { method: 'POST', headers: { 'Content-Type': media.mimeType }, body: media.file });
        const result = await upload.json();
        if (!upload.ok) throw Error(result.error ?? 'Não foi possível salvar a mídia.');
        mediaId = result.id; setMedia(result);
      }
      const r = await fetch(`${api}/campaigns${campaignId ? `/${campaignId}` : ''}`, { method: campaignId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaId, name: form.get('name'), mode, intervalSeconds: interval * 60, startsAt: form.get('startsAt'), endsAt: form.get('endsAt'), groupIds: selected, messages: form.getAll('message'), times: mode === 'SCHEDULED' ? times : [] }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error ?? 'Erro ao criar campanha.'); router.push(`/campanhas/${data.id}`); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'API indisponível.'); } finally { setSaving(false); }
  }
  return <main className="p-6 md:p-12"><form onSubmit={submit} className="mx-auto max-w-3xl space-y-7">
    <header><p className="text-sm font-semibold text-emerald-600">PLANEJAMENTO</p><h1 className="mt-2 text-3xl font-bold">{campaignId ? 'Editar campanha' : 'Nova campanha'}</h1><p className="mt-2 text-slate-500">Salve, confira o resumo e só então inicie os envios.</p><ServerClock /></header>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
    {!loaded && <p>Carregando rascunho…</p>}
    {loaded && <><section className={panel}><label className="block text-sm font-medium">Nome<input defaultValue={initial.name} required maxLength={200} name="name" className={field} placeholder="Ex.: Festival de Inverno" /></label>
      <label className="block text-sm font-medium">Quando enviar<select value={mode} onChange={e => setMode(e.target.value)} className={field}><option value="IMMEDIATE">Fila única — começa quando eu iniciar</option><option value="SCHEDULED">Horários diários — agendamento existente</option></select></label>
{mode === 'SCHEDULED' && <><p className="text-sm text-slate-500">Datas inclusivas e horário de Brasília (America/Sao_Paulo). Se uma rodada atrasar, a próxima espera: nunca há envios simultâneos nesta campanha.</p><div className="grid gap-4 md:grid-cols-2"><label>Início<input defaultValue={initial.startsAt} required name="startsAt" type="date" className={field} /></label><label>Fim<input defaultValue={initial.endsAt} required name="endsAt" type="date" className={field} /></label></div><div className="space-y-2">{times.map((time, i) => <div key={i} className="flex gap-2"><input aria-label={`Horário ${i + 1}`} required type="time" value={time} onChange={e => setTimes(current => current.map((t, n) => n === i ? e.target.value : t))} className="rounded border p-2" />{times.length > 1 && <button type="button" onClick={() => setTimes(current => current.filter((_, n) => n !== i))}>Remover</button>}</div>)}<button type="button" disabled={times.length >= 24} onClick={() => setTimes(current => [...current, '18:00'])} className="text-emerald-700">+ Adicionar horário</button></div></>}
      <label className="block text-sm font-medium">Intervalo entre envios (minutos)<input type="number" required min={1} max={60} step={1} value={interval} onChange={e => setIntervalValue(Number(e.target.value))} className={field} /></label>
    </section>
    <section className={panel}><h2 className="font-bold">Grupos participantes</h2><p className="text-sm text-slate-500">Selecione na ordem desejada ou ajuste a fila abaixo. Para importar grupos, use Conexão WhatsApp.</p>
      {!groups.length && <a href="/configuracoes" className="text-emerald-700">Conectar e sincronizar grupos →</a>}
      {!!groups.length && <div className="space-y-2">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
          placeholder="Buscar grupo pelo nome…"
          aria-label="Buscar grupo pelo nome"
          className={field}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
          <span>{term ? `${visible.length} de ${groups.length} grupos` : `${groups.length} grupos`} · {selected.length} selecionados</span>
          <span className="flex gap-3">
            <button type="button" onClick={selectVisible} disabled={!visible.some(group => !selected.includes(group.id))} className="text-emerald-700 disabled:opacity-40">{term ? 'Selecionar exibidos' : 'Selecionar todos'}</button>
            <button type="button" onClick={() => setSelected([])} disabled={!selected.length} className="text-slate-600 disabled:opacity-40">Limpar seleção</button>
          </span>
        </div>
      </div>}
      <div className="max-h-64 space-y-2 overflow-y-auto">{visible.map(group => <label key={group.id} className="flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(group.id)} onChange={() => toggle(group.id)} />{group.name}{!group.externalId && ' (simulação)'}</label>)}</div>
      {!!groups.length && !visible.length && <p className="text-sm text-slate-500">Nenhum grupo encontrado para “{search.trim()}”.</p>}
      {!!selected.length && <ol className="space-y-2 border-t pt-4">{selected.map((id, i) => <li key={id} className="flex items-center gap-3 text-sm"><span className="flex-1">{i + 1}. {groups.find(g => g.id === id)?.name ?? 'Grupo indisponível'}</span><button type="button" aria-label={`Remover grupo ${i + 1}`} onClick={() => toggle(id)} className="rounded border px-2 text-red-700">×</button><button type="button" aria-label={`Subir grupo ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded border px-2 disabled:opacity-30">↑</button><button type="button" aria-label={`Descer grupo ${i + 1}`} disabled={i === selected.length - 1} onClick={() => move(i, 1)} className="rounded border px-2 disabled:opacity-30">↓</button></li>)}</ol>}
    </section>
    <section className={panel}>{initial.messages.map((message, i) => <label key={i} className="block text-sm font-medium">Mensagem {initial.messages.length > 1 ? i + 1 : ''}<textarea defaultValue={message} required maxLength={10000} name="message" className={`${field} min-h-28`} /></label>)}<p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{selected.length} grupos · Intervalo: {interval} min · Aproximadamente {Math.max(0, selected.length - 1) * interval} min entre o primeiro e o último envio de cada rodada, sem contar pausas e atrasos.</p></section>
    <CampaignMediaInput value={media} onChange={setMedia} disabled={saving} />
    <button disabled={saving || !selected.length} className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white disabled:opacity-50">{saving ? 'Validando e salvando…' : 'Salvar e conferir campanha'}</button>
    </>}
    {campaignId && <a className="ml-4 text-slate-600" href={`/campanhas/${campaignId}`}>Voltar sem salvar</a>}
  </form></main>;
}
