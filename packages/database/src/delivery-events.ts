import type { PrismaClient } from '@prisma/client';
import { LOCKING_TRANSACTION, lockCampaign, retryAt, MAX_SEND_ATTEMPTS } from './queue';

// O que o servidor do WhatsApp informa DEPOIS do sendMessage (ADR-012).
//
// sendMessage só escreve a mensagem no socket e devolve um id: ele não espera o servidor
// aceitá-la. Se o servidor recusar, chega um "ack" de erro separado; se aceitar e entregar,
// chegam recibos de entrega dos participantes. Estes eventos transformam "pedido feito" em
// "entregue" ou "recusado". Uma recusa comprova que nada chegou ao grupo: o envio volta à
// fila para nova tentativa, até o limite (ADR-014).
// ownerId = dono da conexão que recebeu o evento (ADR-022): um evento de A nunca altera um
// envio de B. null só na sessão global legada sem dono definido (some na 4E).
type EventBase = { messageId: string; groupJid: string; accountJid: string; at: Date; ownerId?: string | null };
export type ServerEvent =
  | ({ kind: 'delivered' } & EventBase)
  | ({ kind: 'rejected'; code: string } & EventBase);

export const REJECTED_MESSAGE = (code: string) =>
  `O WhatsApp recusou a mensagem (código ${code}); ela não aparece no grupo.`;

/**
 * Aplica um evento a uma entrega enviada pelo sistema. Devolve true quando o evento já está
 * refletido (inclusive se for repetido) e false quando a entrega correspondente ainda não
 * foi gravada — o chamador tenta de novo mais tarde.
 */
export async function applyServerEvent(db: PrismaClient, event: ServerEvent): Promise<boolean> {
  if (!event.messageId || !event.groupJid.endsWith('@g.us') || !event.accountJid) return true;
  const matches = await db.delivery.findMany({
    where: {
      provider: 'baileys', providerId: event.messageId,
      campaign: { accountJid: event.accountJid, ...(event.ownerId ? { userId: event.ownerId } : {}) },
      group: { externalId: event.groupJid, ...(event.ownerId ? { userId: event.ownerId } : {}) },
    },
    take: 2,
    select: { id: true, campaignId: true },
  });
  if (!matches.length) return false;
  // Associação ambígua: nunca atribui o evento a uma entrega qualquer.
  if (matches.length > 1) return true;
  const [{ id, campaignId }] = matches;

  await db.$transaction(async tx => {
    await lockCampaign(tx, campaignId);
    const delivery = await tx.delivery.findUniqueOrThrow({ where: { id } });
    // O reenvio já saiu com outro id: este evento é da mensagem antiga.
    if (delivery.providerId !== event.messageId) return;

    if (event.kind === 'delivered') {
      if (delivery.status === 'PENDING') {
        // Estava esperando reenvio por causa de uma recusa, mas a mensagem chegou: cancela
        // o reenvio (nunca duplicar).
        await tx.delivery.update({ where: { id }, data: { status: 'SENT', deliveredAt: event.at, error: null, updatedAt: event.at } });
      } else if (!delivery.deliveredAt) {
        await tx.delivery.update({ where: { id }, data: { deliveredAt: event.at } });
      }
      return;
    }

    if (delivery.serverRejectedAt) return;
    const errorCode = `servidor:${event.code}`.slice(0, 64);
    // Já houve recibo de entrega: a mensagem chegou a alguém. Registra o código, mas não
    // declara falha de algo que foi entregue.
    if (delivery.deliveredAt || delivery.status !== 'SENT') {
      await tx.delivery.update({ where: { id }, data: { serverRejectedAt: event.at, errorCode } });
      return;
    }
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const retry = !campaign.deletedAt && ['ACTIVE', 'PAUSED', 'COMPLETED'].includes(campaign.status) ? retryAt(delivery.attempts, event.at) : null;
    if (retry) {
      await tx.delivery.update({ where: { id }, data: { status: 'PENDING', scheduledAt: retry, serverRejectedAt: event.at, errorCode, error: REJECTED_MESSAGE(event.code), updatedAt: event.at } });
      // A campanha pode ter terminado entre o envio e a recusa: reabre para a nova tentativa.
      if (campaign.status === 'COMPLETED') await tx.campaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', updatedAt: event.at } });
      return;
    }
    const tries = delivery.attempts > 1 ? `Falhou nas ${Math.min(delivery.attempts, MAX_SEND_ATTEMPTS)} tentativas. ` : '';
    await tx.delivery.update({ where: { id }, data: { status: 'FAILED', serverRejectedAt: event.at, errorCode, error: tries + REJECTED_MESSAGE(event.code), updatedAt: event.at } });
  }, LOCKING_TRANSACTION);
  return true;
}
