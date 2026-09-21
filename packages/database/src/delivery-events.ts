import type { PrismaClient } from '@prisma/client';

// O que o servidor do WhatsApp informa DEPOIS do sendMessage (ADR-012).
//
// sendMessage só escreve a mensagem no socket e devolve um id: ele não espera o servidor
// aceitá-la. Se o servidor recusar, chega um "ack" de erro separado; se aceitar e entregar,
// chegam recibos de entrega dos participantes. Estes eventos transformam "pedido feito" em
// "entregue" ou "recusado". Nada aqui reenvia mensagem (ADR-003).
export type ServerEvent =
  | { kind: 'delivered'; messageId: string; groupJid: string; accountJid: string; at: Date }
  | { kind: 'rejected'; messageId: string; groupJid: string; accountJid: string; at: Date; code: string };

export const REJECTED_MESSAGE = (code: string) =>
  `O WhatsApp recusou a mensagem depois do envio (código ${code}); ela não aparece no grupo. Não foi reenviada automaticamente.`;

/**
 * Aplica um evento a uma entrega enviada pelo sistema. Devolve true quando o evento já está
 * refletido (inclusive se for repetido) e false quando a entrega correspondente ainda não
 * foi gravada — o chamador tenta de novo mais tarde.
 */
export async function applyServerEvent(db: PrismaClient, event: ServerEvent): Promise<boolean> {
  if (!event.messageId || !event.groupJid.endsWith('@g.us') || !event.accountJid) return true;
  const matches = await db.delivery.findMany({
    where: { provider: 'baileys', providerId: event.messageId, campaign: { accountJid: event.accountJid }, group: { externalId: event.groupJid } },
    take: 2,
    select: { id: true, status: true, deliveredAt: true, serverRejectedAt: true },
  });
  if (!matches.length) return false;
  // Associação ambígua: nunca atribui o evento a uma entrega qualquer.
  if (matches.length > 1) return true;
  const [delivery] = matches;

  if (event.kind === 'delivered') {
    if (!delivery.deliveredAt) {
      await db.delivery.updateMany({ where: { id: delivery.id, deliveredAt: null }, data: { deliveredAt: event.at } });
    }
    return true;
  }

  if (delivery.serverRejectedAt) return true;
  // Já houve recibo de entrega: a mensagem chegou a alguém. Registra o código, mas não
  // declara falha de algo que foi entregue.
  if (delivery.deliveredAt) {
    await db.delivery.updateMany({ where: { id: delivery.id }, data: { serverRejectedAt: event.at, errorCode: `servidor:${event.code}`.slice(0, 64) } });
    return true;
  }
  await db.delivery.updateMany({
    where: { id: delivery.id, status: 'SENT' },
    data: { status: 'FAILED', serverRejectedAt: event.at, errorCode: `servidor:${event.code}`.slice(0, 64), error: REJECTED_MESSAGE(event.code), updatedAt: event.at },
  });
  return true;
}
