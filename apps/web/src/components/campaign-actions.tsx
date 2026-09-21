import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
export function CampaignActions({ id, status, provider = 'simulator', groupCount = 0, intervalSeconds = 180, mode = 'SCHEDULED', connectionState = 'unavailable', onChanged }: { id: string; status: string; provider?: string; groupCount?: number; intervalSeconds?: number; mode?: string; connectionState?: string; onChanged?: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [choice, setChoice] = useState(provider);
  const real = (status === 'DRAFT' ? choice : provider) === 'baileys';
  const connected = connectionState === 'connected';
  async function update(nextStatus: 'ACTIVE' | 'PAUSED' | 'CANCELLED') {
    const selected = status === 'DRAFT' ? choice : provider;
    if (nextStatus === 'ACTIVE' && !confirm(`${status === 'PAUSED' ? 'Retomar somente os pendentes' : 'Iniciar campanha'}?\n${groupCount} grupos selecionados\nIntervalo: ${intervalSeconds / 60} minutos\nDuração mínima por rodada: ${Math.max(0, groupCount - 1) * intervalSeconds / 60} minutos\n${mode === 'IMMEDIATE' ? 'Primeiro envio ao iniciar; os seguintes entram na fila.' : 'Primeiro envio no horário agendado; rodadas não se sobrepõem.'}\n${selected === 'baileys' ? 'ENVIO REAL: confirmo que os grupos autorizaram estas mensagens.' : 'SIMULAÇÃO: nenhuma mensagem chega ao WhatsApp.'}`)) return;
    if (nextStatus === 'CANCELLED' && !confirm('Encerrar definitivamente e cancelar os pendentes? Não será possível retomar. Um envio já iniciado poderá terminar.')) return;
    setBusy(true); setError('');
    try {
      await api(`/campaigns/${id}/status`, { method: 'PATCH', json: { status: nextStatus, provider: selected, consent: selected === 'baileys' } });
      onChanged?.();
    } catch (e) { setError(errorMessage(e, 'Não foi possível atualizar a campanha.')); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('Tem certeza que deseja excluir esta campanha? Ela sairá da lista; histórico e métricas serão preservados.')) return;
    setBusy(true); setError('');
    try { await api(`/campaigns/${id}`, { method: 'DELETE' }); onChanged?.(); navigate('/campanhas'); }
    catch (e) { setError(errorMessage(e, 'Falha ao excluir.')); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 flex flex-wrap items-center gap-2">
    <span className="text-sm font-semibold">{(status === 'DRAFT' ? choice : provider) === 'baileys' ? 'WhatsApp real' : 'Simulação'}</span>
    {status === 'DRAFT' && <Link to={`/campanhas/${id}/editar`} className="rounded border px-3 py-2 text-emerald-700">Editar</Link>}
    {status === 'DRAFT' && <select aria-label="Modo de envio" value={choice} disabled={busy} onChange={e => setChoice(e.target.value)} className="rounded border p-2"><option value="simulator">Simulação</option><option value="baileys">WhatsApp real</option></select>}
    {real && <p role="status" className={`w-full text-sm ${connected ? 'text-emerald-700' : 'text-amber-800'}`}>{connected ? 'WhatsApp conectado.' : <>WhatsApp {connectionState === 'unavailable' ? 'indisponível' : 'desconectado'}. {status === 'ACTIVE' ? 'Fila aguardando conexão; não está enviando normalmente.' : 'Conecte antes de iniciar ou retomar.'} <Link to="/configuracoes" className="underline">Ver conexão</Link></>}</p>}
    {['DRAFT', 'PAUSED'].includes(status) && <button disabled={busy || (real && !connected)} onClick={() => update('ACTIVE')} className="rounded-md bg-emerald-600 px-3 py-2 text-white disabled:opacity-50">{status === 'PAUSED' ? 'Retomar' : 'Ativar'}</button>}
    {status === 'ACTIVE' && <button disabled={busy} onClick={() => update('PAUSED')} className="rounded border px-3 py-2">Pausar</button>}
    {!['CANCELLED', 'COMPLETED'].includes(status) && <button disabled={busy} onClick={() => update('CANCELLED')} className="px-3 py-2 text-red-700">Encerrar</button>}
    {['DRAFT', 'CANCELLED', 'COMPLETED'].includes(status) && <button disabled={busy} onClick={remove} className="px-3 py-2 text-sm text-slate-500">Excluir</button>}
    {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
  </div>;
}
