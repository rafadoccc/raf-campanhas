import { PrismaClient, Prisma } from '@prisma/client';
import { currentTime } from './clock';

export function resumeAt(next: Date | null, pausedAt: Date | null, now: Date) {
  return new Date(now.getTime() + (next && pausedAt ? Math.max(0, next.getTime() - pausedAt.getTime()) : 0));
}

export async function completeFinished(db: PrismaClient) {
  const now = await currentTime();
  return db.campaign.updateMany({
    where: { deletedAt: null, status: { in: ['ACTIVE', 'PAUSED'] }, deliveries: { some: {}, none: { status: { in: ['PENDING', 'PROCESSING'] } } } },
    data: { status: 'COMPLETED', pausedAt: null, updatedAt: now }
  });
}

// O InnoDB usa REPEATABLE READ por padrão: a transação congela um snapshot na primeira
// leitura. Nas transações da fila essa primeira leitura acontece ANTES do lock da
// campanha, então uma pausa confirmada enquanto esperávamos o lock ficaria invisível e o
// envio sairia mesmo com a campanha pausada. READ COMMITTED faz cada comando enxergar o
// que já foi confirmado — a semântica que a fila sempre assumiu (era o padrão do
// PostgreSQL). Use em toda transação que chama lockCampaign.
export const LOCKING_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

export async function lockCampaign(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM \`Campaign\` WHERE id = ${id} FOR UPDATE`;
}

// One durable claim per delivery. A crash after this point is deliberately NOT retried.
export async function claimDelivery(db: PrismaClient, id: string, now?: Date) {
  now ??= await currentTime();
  const at = now;
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const candidate = await tx.delivery.findUnique({ where: { id } });
    if (!candidate) return null;
    await lockCampaign(tx, candidate.campaignId);
    const campaign = await tx.campaign.findUnique({ where: { id: candidate.campaignId } });
    if (!campaign || campaign.deletedAt || campaign.status !== 'ACTIVE' || (campaign.nextAvailableAt && campaign.nextAvailableAt > at)) return null;
    const head = await tx.delivery.findFirst({ where: { campaignId: campaign.id, status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { sequence: 'asc' }, include: { group: true } });
    if (!head || head.id !== id || head.status !== 'PENDING' || head.scheduledAt > at) return null;
    const claimed = await tx.delivery.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'PROCESSING', attemptedAt: at, updatedAt: at, error: null } });
    if (!claimed.count) return null;
    await tx.campaign.update({ where: { id: campaign.id }, data: { nextAvailableAt: new Date(at.getTime() + campaign.intervalSeconds * 1000), updatedAt: at } });
    return { ...head, campaign };
  }, LOCKING_TRANSACTION);
}

export async function finishDelivery(db: PrismaClient, id: string, outcome: { providerId: string } | { error: string }, now?: Date) {
  now ??= await currentTime();
  const at = now;
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const delivery = await tx.delivery.findUnique({ where: { id } });
    if (!delivery) return;
    await lockCampaign(tx, delivery.campaignId);
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: delivery.campaignId } });
    const changed = await tx.delivery.updateMany({ where: { id, status: 'PROCESSING' }, data: 'providerId' in outcome
      ? { status: 'SENT', providerId: outcome.providerId, sentAt: at, updatedAt: at, error: null }
      : { status: 'FAILED', updatedAt: at, error: outcome.error } });
    if (!changed.count) return;
    // Full interval after completion, even after a slow send or a restart.
    await tx.campaign.update({ where: { id: campaign.id }, data: { nextAvailableAt: new Date(at.getTime() + campaign.intervalSeconds * 1000), updatedAt: at, ...(campaign.status === 'PAUSED' ? { pausedAt: at } : {}) } });
    const remaining = await tx.delivery.count({ where: { campaignId: campaign.id, status: { in: ['PENDING', 'PROCESSING'] } } });
    if (!remaining && ['ACTIVE', 'PAUSED'].includes(campaign.status)) await tx.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED', pausedAt: null, updatedAt: at } });
  }, LOCKING_TRANSACTION);
}
