import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { primaryButton, secondaryButton } from './ui';

type Props = { id: string; status: string; provider?: string; groupCount?: number; intervalSeconds?: number; connectionState?: string; onChanged?: () => void };

export function CampaignActions({ id, status, provider = 'simulator', groupCount = 0, intervalSeconds = 180, connectionState = 'unavailable', onChanged }: Props) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [choice, setChoice] = useState(provider);
  const selected = status === 'DRAFT' ? choice : provider;
  const real = selected === 'baileys';
  const connected = connectionState === 'connected';

  async function update(nextStatus: 'ACTIVE' | 'PAUSED' | 'CANCELLED') {
    if (nextStatus === 'ACTIVE') {
      const duration = Math.max(0, groupCount - 1) * intervalSeconds / 60;
      const kind = real ? 'ENVIO REAL — confirmo que os grupos autorizaram estas mensagens.' : 'Simulação — nada chega ao WhatsApp.';
      if (!confirm(`${status === 'PAUSED' ? 'Retomar' : 'Iniciar'} a campanha?\n\n${groupCount} grupos · a cada ${intervalSeconds / 60} min · ~${duration} min por rodada\n${kind}`)) return;
    }
    if (nextStatus === 'CANCELLED' && !confirm('Encerrar a campanha e cancelar os envios pendentes? Não dá para retomar.')) return;
    setBusy(true); setError('');
    try {
      await api(`/campaigns/${id}/status`, { method: 'PATCH', json: { status: nextStatus, provider: selected, consent: real } });
      onChanged?.();
    } catch (e) { setError(errorMessage(e, 'Não foi possível atualizar a campanha.')); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('Excluir esta campanha? O histórico de envios é preservado.')) return;
    setBusy(true); setError('');
    try { await api(`/campaigns/${id}`, { method: 'DELETE' }); onChanged?.(); navigate('/campanhas'); }
    catch (e) { setError(errorMessage(e, 'Falha ao excluir.')); }
    finally { setBusy(false); }
  }

  return <div className="mt-5 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      {status === 'DRAFT' && <select aria-label="Modo de envio" value={choice} disabled={busy} onChange={e => setChoice(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm"><option value="simulator">Simulação</option><option value="baileys">WhatsApp real</option></select>}
      {['DRAFT', 'PAUSED'].includes(status) && <button type="button" disabled={busy || (real && !connected)} onClick={() => update('ACTIVE')} className={primaryButton}>{status === 'PAUSED' ? 'Retomar' : 'Iniciar'}</button>}
      {status === 'ACTIVE' && <button type="button" disabled={busy} onClick={() => update('PAUSED')} className={secondaryButton}>Pausar</button>}
      {status === 'DRAFT' && <Link to={`/campanhas/${id}/editar`} className={secondaryButton}>Editar</Link>}
      <span className="ml-auto flex gap-1">
        {!['CANCELLED', 'COMPLETED'].includes(status) && <button type="button" disabled={busy} onClick={() => update('CANCELLED')} className="rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50">Encerrar</button>}
        {['DRAFT', 'CANCELLED', 'COMPLETED'].includes(status) && <button type="button" disabled={busy} onClick={remove} className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-50">Excluir</button>}
      </span>
    </div>
    {real && !connected && !['CANCELLED', 'COMPLETED'].includes(status) && <p role="status" className="text-sm text-amber-800">WhatsApp {connectionState === 'unavailable' ? 'indisponível' : 'desconectado'}{status === 'ACTIVE' ? ': os envios esperam a conexão.' : '.'} <Link to="/configuracoes" className="underline">Conectar</Link></p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
