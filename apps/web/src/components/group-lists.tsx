import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { Alert, Button, IconList, IconRemove, inputClass, useConfirm } from '../design';

// Listas de grupos (ADR-047): um nome para um conjunto de grupos. No formulário da campanha, um
// clique na lista marca todos os grupos dela (outro clique desmarca); "Salvar seleção como lista"
// guarda os grupos marcados agora.

type GroupList = { id: string; name: string; groupIds: string[] };
type Props = {
  /** Ids dos grupos que existem e estão ativos (grupo que saiu do WhatsApp não é marcado). */
  available: string[];
  selected: string[];
  onSelect: (next: string[]) => void;
};

export function GroupListsBar({ available, selected, onSelect }: Props) {
  const confirm = useConfirm();
  const [lists, setLists] = useState<GroupList[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [listName, setListName] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { api<GroupList[]>('/group-lists').then(setLists).catch(() => setLists([])); }, []);

  const usable = (list: GroupList) => list.groupIds.filter(id => available.includes(id));
  const isOn = (list: GroupList) => { const ids = usable(list); return ids.length > 0 && ids.every(id => selected.includes(id)); };
  function toggle(list: GroupList) {
    const ids = usable(list);
    onSelect(isOn(list) ? selected.filter(id => !ids.includes(id)) : [...selected, ...ids.filter(id => !selected.includes(id))]);
  }
  async function save() {
    const name = listName.trim();
    if (!name) return;
    setBusy(true); setError('');
    try {
      let saved: GroupList;
      try { saved = await api<GroupList>('/group-lists', { method: 'POST', json: { name, groupIds: selected } }); }
      catch (e) {
        // Nome que já existe: oferece trocar os grupos da lista pela seleção atual.
        const existing = lists?.find(list => list.name.toLowerCase() === name.toLowerCase());
        if (!(e instanceof ApiError) || e.status !== 409 || !existing) throw e;
        if (!await confirm({ title: `Atualizar a lista "${existing.name}"?`, description: 'Ela já existe. Os grupos dela passam a ser os que estão marcados agora.', confirmLabel: 'Atualizar' })) return;
        saved = await api<GroupList>(`/group-lists/${existing.id}`, { method: 'PATCH', json: { groupIds: selected } });
      }
      setLists(current => [...(current ?? []).filter(list => list.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setNaming(false); setListName('');
    } catch (e) { setError(errorMessage(e, 'Não foi possível salvar a lista.')); }
    finally { setBusy(false); }
  }
  async function remove(list: GroupList) {
    if (!await confirm({ title: `Excluir a lista "${list.name}"?`, description: 'Só a lista some. Os grupos e as campanhas continuam como estão.', confirmLabel: 'Excluir', danger: true })) return;
    setError('');
    try { await api(`/group-lists/${list.id}`, { method: 'DELETE' }); setLists(current => current?.filter(item => item.id !== list.id) ?? null); }
    catch (e) { setError(errorMessage(e)); }
  }

  if (!lists) return null;
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted"><IconList className="h-3.5 w-3.5" aria-hidden />Listas</span>
      {lists.length === 0 && !naming && <span className="text-xs text-slate-400">Marque os grupos e salve como lista para reutilizar depois.</span>}
      {lists.map(list => {
        const on = isOn(list); const count = usable(list).length;
        return <span key={list.id} className={`inline-flex h-7 items-center rounded border text-xs transition-colors ${on ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-line bg-white text-ink'}`}>
          <button type="button" aria-pressed={on} disabled={!count} onClick={() => toggle(list)} title={count ? (on ? 'Desmarcar os grupos desta lista' : 'Marcar os grupos desta lista') : 'Nenhum grupo desta lista está disponível'}
            className="h-full rounded-l px-2 font-medium hover:bg-slate-50 disabled:text-slate-400">{list.name} <span className="tabular font-normal text-muted">{count}</span></button>
          <button type="button" aria-label={`Excluir a lista ${list.name}`} title="Excluir a lista" onClick={() => void remove(list)} className="grid h-full w-6 place-items-center rounded-r border-l border-line text-slate-400 hover:bg-red-50 hover:text-red-700"><IconRemove className="h-3 w-3" aria-hidden /></button>
        </span>;
      })}
      {!naming && <Button size="sm" variant="ghost" disabled={!selected.length} title={selected.length ? undefined : 'Marque ao menos um grupo'} onClick={() => { setNaming(true); setError(''); }}>Salvar seleção como lista</Button>}
    </div>
    {/* Sem <form>: este bloco fica DENTRO do formulário da campanha, e formulário não se aninha.
        Enter salva a lista (e não envia a campanha). */}
    {naming && <div className="flex animate-fade-in flex-wrap items-center gap-2">
      <input value={listName} onChange={e => setListName(e.target.value)} maxLength={80} autoFocus placeholder="Nome da lista (ex.: Universitários)" aria-label="Nome da lista" className={`${inputClass} !w-64 max-w-full`}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } if (e.key === 'Escape') setNaming(false); }} />
      <Button size="sm" variant="primary" loading={busy} disabled={busy || !listName.trim()} onClick={() => void save()}>Salvar {selected.length} {selected.length === 1 ? 'grupo' : 'grupos'}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setNaming(false)}>Cancelar</Button>
    </div>}
    {error && <Alert>{error}</Alert>}
  </div>;
}
