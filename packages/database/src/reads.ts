import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// ownerId = dono da conexão que recebeu o recibo (ADR-022). Um recibo de A nunca pode casar
// com um envio de B. null só existe na sessão global legada, enquanto ela não tem dono (4E).
export type ReadReceipt = { messageId: string; groupJid: string; accountJid: string; participant: string; readAt: Date; ownerId?: string | null };
export async function persistRead(db: PrismaClient, receipt: ReadReceipt) {
  if (!receipt.messageId || !receipt.accountJid || !receipt.groupJid.endsWith('@g.us') || !receipt.participant || !Number.isFinite(receipt.readAt.getTime()) || receipt.readAt.getTime() <= 0) return;
  const id = createHash('sha256').update(JSON.stringify([receipt.ownerId ?? '', receipt.accountJid, receipt.groupJid, receipt.messageId, receipt.participant])).digest('hex');
  await db.pendingRead.createMany({ data: [{ id, ...receipt, ownerId: receipt.ownerId ?? null }], skipDuplicates: true });
}

/**
 * Aplica os recibos pendentes de UMA conexão. `ownerId` null = sessão global legada, que também
 * cuida das linhas antigas sem dono (gravadas antes da Fase 4D).
 */
export async function flushPendingReads(db: PrismaClient, owner: { ownerId: string | null; includeUnowned?: boolean } = { ownerId: null, includeUnowned: true }) {
  const now = new Date();
  const scope = owner.ownerId
    ? (owner.includeUnowned ? { OR: [{ ownerId: owner.ownerId }, { ownerId: null }] } : { ownerId: owner.ownerId })
    : { ownerId: null };
  const pending = await db.pendingRead.findMany({ where: { nextAttemptAt: { lte: now }, ...scope }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 200 });
  for (const receipt of pending) {
    // Replay after interruption is safe because DeliveryRead has a unique key.
    if (await recordRead(db, receipt)) await db.pendingRead.deleteMany({ where: { id: receipt.id } });
    else await db.pendingRead.updateMany({ where: { id: receipt.id }, data: { nextAttemptAt: new Date(now.getTime() + 60000) } });
  }
}
export async function recordRead(db: PrismaClient, receipt: ReadReceipt) {
  if (!receipt.groupJid.endsWith('@g.us') || !receipt.participant || !Number.isFinite(receipt.readAt.getTime()) || receipt.readAt.getTime() <= 0) return false;
  const matches = await db.delivery.findMany({ where: {
    provider: 'baileys', status: 'SENT', providerId: receipt.messageId,
    // Além do número, do grupo e do id da mensagem, o DONO da conexão (ADR-022).
    campaign: { accountJid: receipt.accountJid, ...(receipt.ownerId ? { userId: receipt.ownerId } : {}) },
    group: { externalId: receipt.groupJid, ...(receipt.ownerId ? { userId: receipt.ownerId } : {}) }
  }, take: 2, select: { id: true } });
  // Refuse ambiguous associations; never attribute a receipt to an arbitrary campaign.
  if (matches.length !== 1) return false;
  const deliveryId = matches[0].id;
  const recipientHash = createHash('sha256').update(`${deliveryId}:${receipt.participant}`).digest('hex');
  await db.deliveryRead.createMany({ data: [{ deliveryId, recipientHash, readAt: receipt.readAt }], skipDuplicates: true });
  return true;
}

export async function campaignReads(db: PrismaClient, campaignId: string) {
  const rows = await db.$queryRaw<{ groupId: string; count: bigint }[]>`
    SELECT d.\`groupId\` AS groupId, COUNT(*) AS count FROM \`DeliveryRead\` r
    JOIN \`Delivery\` d ON d.id = r.\`deliveryId\`
    WHERE d.\`campaignId\` = ${campaignId} AND d.provider = 'baileys' AND d.status = 'SENT'
    GROUP BY d.\`groupId\``;
  return rows.map((row: { groupId: string; count: bigint }) => ({ groupId: row.groupId, count: Number(row.count) }));
}
