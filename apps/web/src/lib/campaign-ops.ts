import { api } from './api';

// Ações de campanha usadas pela lista e pelo detalhe, com as mesmas regras nas duas telas.
type Confirm = (options: { title: string; description?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
type Campaign = { id: string; name: string; status: string };

/** Qual "editar" faz sentido agora (ADR-026). */
export function editAction(status: string): { kind: 'edit' | 'reuse' | 'reschedule'; label: string; title: string } {
  if (status === 'DRAFT') return { kind: 'edit', label: 'Editar', title: 'Editar o rascunho' };
  if (status === 'ACTIVE' || status === 'PAUSED') return { kind: 'reschedule', label: 'Reagendar', title: 'Para os envios pendentes e abre uma nova rodada para escolher outro horário' };
  return { kind: 'reuse', label: 'Usar de novo', title: 'Nova rodada com os mesmos grupos, mensagem e mídia; o histórico desta fica guardado' };
}

/**
 * Executa o "editar" certo e devolve o id da campanha a abrir no formulário (ou null se o
 * usuário desistiu). Rascunho abre ele mesmo; as demais viram uma nova rodada em rascunho.
 */
export async function editCampaign(campaign: Campaign, confirm: Confirm): Promise<string | null> {
  const action = editAction(campaign.status);
  if (action.kind === 'edit') return campaign.id;
  if (action.kind === 'reschedule' && !await confirm({
    title: 'Reagendar esta campanha?',
    description: 'Os envios que ainda não saíram são cancelados e uma nova rodada, com os mesmos grupos, mensagem e mídia, abre para você escolher o horário. O que já foi enviado fica no histórico.',
    confirmLabel: 'Reagendar',
  })) return null;
  const copy = await api<{ id: string }>(`/campaigns/${campaign.id}/duplicate`, { method: 'POST', json: { reschedule: action.kind === 'reschedule' } });
  return copy.id;
}

/** Excluir com confirmação. Campanha ativa ou pausada é encerrada antes (envios pendentes cancelados). */
export async function deleteCampaign(campaign: Campaign, confirm: Confirm): Promise<boolean> {
  const running = campaign.status === 'ACTIVE' || campaign.status === 'PAUSED';
  if (!await confirm({
    title: `Excluir "${campaign.name}"?`,
    description: running
      ? 'A campanha está em andamento: os envios que ainda não saíram serão cancelados antes. O histórico do que já foi enviado continua nos relatórios.'
      : 'Ela sai da lista. O histórico do que já foi enviado continua nos relatórios.',
    confirmLabel: 'Excluir',
    danger: true,
  })) return false;
  if (running) await api(`/campaigns/${campaign.id}/status`, { method: 'PATCH', json: { status: 'CANCELLED' } });
  await api(`/campaigns/${campaign.id}`, { method: 'DELETE' });
  return true;
}
