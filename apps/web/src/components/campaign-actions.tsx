import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { deleteCampaign, editAction, editCampaign } from '../lib/campaign-ops';
import { Alert, Button, IconButton, IconDelete, IconEdit, IconPause, IconReschedule, IconReuse, IconStart, IconStop, inputClass, useConfirm } from '../design';

type Props = { id: string; name: string; status: string; provider?: string; groupCount?: number; intervalSeconds?: number; connectionState?: string; onChanged?: () => void };
const editIcon = { edit: IconEdit, reuse: IconReuse, reschedule: IconReschedule } as const;

export function CampaignActions({ id, name, status, provider = 'simulator', groupCount = 0, intervalSeconds = 180, connectionState = 'unavailable', onChanged }: Props) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [choice, setChoice] = useState(provider);
  const selected = status === 'DRAFT' ? choice : provider;
  const real = selected === 'baileys';
  const connected = connectionState === 'connected';
  const edit = editAction(status);
  const EditIcon = editIcon[edit.kind];

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e, 'Não foi possível atualizar a campanha.')); }
    finally { setBusy(false); }
  }
  const update = (next: 'ACTIVE' | 'PAUSED' | 'CANCELLED') => run(async () => {
    if (next === 'ACTIVE') {
      const minutes = Math.max(0, groupCount - 1) * intervalSeconds / 60;
      const ok = await confirm({
        title: status === 'PAUSED' ? 'Retomar a campanha?' : 'Iniciar a campanha?',
        description: `${groupCount} grupos, um a cada ${intervalSeconds / 60} min (~${minutes} min por rodada). ${real ? 'ENVIO REAL: confirmo que os grupos autorizaram estas mensagens.' : 'Simulação: nada chega ao WhatsApp.'}`,
        confirmLabel: status === 'PAUSED' ? 'Retomar' : 'Iniciar',
      });
      if (!ok) return;
    }
    if (next === 'CANCELLED' && !await confirm({ title: 'Encerrar a campanha?', description: 'Os envios que ainda não saíram são cancelados. Não dá para retomar, mas dá para usar de novo depois.', confirmLabel: 'Encerrar', danger: true })) return;
    await api(`/campaigns/${id}/status`, { method: 'PATCH', json: { status: next, provider: selected, consent: real } });
    onChanged?.();
  });

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      {status === 'DRAFT' && <select aria-label="Modo de envio" value={choice} disabled={busy} onChange={e => setChoice(e.target.value)} className={`${inputClass} !w-auto`}><option value="simulator">Simulação</option><option value="baileys">WhatsApp real</option></select>}
      {['DRAFT', 'PAUSED'].includes(status) && <Button variant="primary" icon={IconStart} disabled={busy || (real && !connected)} onClick={() => update('ACTIVE')}>{status === 'PAUSED' ? 'Retomar' : 'Iniciar'}</Button>}
      {status === 'ACTIVE' && <Button icon={IconPause} disabled={busy} onClick={() => update('PAUSED')}>Pausar</Button>}
      <Button icon={EditIcon} title={edit.title} disabled={busy} onClick={() => run(async () => { const target = await editCampaign({ id, name, status }, confirm); if (target) navigate(`/campanhas/${target}/editar`); })}>{edit.label}</Button>
      <span className="ml-auto flex gap-1">
        {['ACTIVE', 'PAUSED'].includes(status) && <Button variant="danger" icon={IconStop} disabled={busy} onClick={() => update('CANCELLED')}>Encerrar</Button>}
        <IconButton icon={IconDelete} label="Excluir" variant="danger" size="md" disabled={busy} onClick={() => run(async () => { if (await deleteCampaign({ id, name, status }, confirm)) navigate('/campanhas'); })} />
      </span>
    </div>
    {real && !connected && !['CANCELLED', 'COMPLETED'].includes(status) && <Alert tone="warning">WhatsApp {connectionState === 'unavailable' ? 'indisponível' : 'desconectado'}{status === 'ACTIVE' ? ': os envios esperam a conexão.' : '.'} <Link to="/configuracoes" className="underline">Conectar</Link></Alert>}
    {error && <Alert>{error}</Alert>}
  </div>;
}
