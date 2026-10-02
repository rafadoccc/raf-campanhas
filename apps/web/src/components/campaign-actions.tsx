import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { editAction, editCampaign } from '../lib/campaign-ops';
import { Alert, Button, IconEdit, IconPause, IconReschedule, IconReuse, IconStart, IconStop, duracaoRodada, useConfirm } from '../design';

type Props = {
  id: string; name: string; status: string; groupCount?: number; connectionState?: string; onChanged?: () => void;
  /** Botões a mais na mesma linha das ações (ex.: "Ver relatório"); quebram para baixo só se não couberem. */
  extra?: ReactNode;
};
const editIcon = { edit: IconEdit, reuse: IconReuse, reschedule: IconReschedule } as const;

// Ações dentro da campanha. O envio é sempre pelo WhatsApp de verdade (a simulação saiu da
// tela). Excluir fica só no cartão da lista de campanhas, longe dos botões do dia a dia.
export function CampaignActions({ id, name, status, groupCount = 0, connectionState = 'unavailable', onChanged, extra }: Props) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
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
      const ok = await confirm({
        title: status === 'PAUSED' ? 'Retomar a campanha?' : 'Iniciar a campanha?',
        description: `${groupCount} grupos, ${duracaoRodada(groupCount)} por rodada. Confirmo que os grupos autorizaram estas mensagens.`,
        confirmLabel: status === 'PAUSED' ? 'Retomar' : 'Iniciar',
      });
      if (!ok) return;
    }
    if (next === 'CANCELLED' && !await confirm({ title: 'Encerrar a campanha?', description: 'Os envios que ainda não saíram são cancelados. Não dá para retomar, mas dá para usar de novo depois.', confirmLabel: 'Encerrar', danger: true })) return;
    await api(`/campaigns/${id}/status`, { method: 'PATCH', json: { status: next, provider: 'baileys', consent: true } });
    onChanged?.();
  });

  const startable = ['DRAFT', 'PAUSED'].includes(status);
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      {startable && <Button variant="primary" icon={IconStart} disabled={busy || !connected} onClick={() => update('ACTIVE')}>{status === 'PAUSED' ? 'Retomar' : 'Iniciar'}</Button>}
      {status === 'ACTIVE' && <Button icon={IconPause} disabled={busy} onClick={() => update('PAUSED')}>Pausar</Button>}
      <Button icon={EditIcon} title={edit.title} disabled={busy} onClick={() => run(async () => { const target = await editCampaign({ id, name, status }, confirm); if (target) navigate(`/campanhas/${target}/editar`); })}>{edit.label}</Button>
      {extra}
      {['ACTIVE', 'PAUSED'].includes(status) && <Button variant="danger" icon={IconStop} className="ml-auto" disabled={busy} onClick={() => update('CANCELLED')}>Encerrar</Button>}
    </div>
    {!connected && !['CANCELLED', 'COMPLETED'].includes(status) && <Alert tone="warning">WhatsApp {connectionState === 'unavailable' ? 'indisponível' : 'desconectado'}{status === 'ACTIVE' ? ': os envios esperam a conexão.' : '.'} <Link to="/configuracoes" className="underline">Conectar</Link></Alert>}
    {error && <Alert>{error}</Alert>}
  </div>;
}
