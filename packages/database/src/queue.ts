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

// ─── Ritmo por número (ADR-006) ─────────────────────────────────────────────────
// O intervalo protege o NÚMERO: campanhas diferentes no mesmo número dividem um único relógio
// (WhatsAppAccount), persistido para valer entre processos e após reinício. Ordem de locks
// fixa em todo o código: número ANTES de campanha (evita deadlock).

/** Número que um envio usa; null = não passa pelo WhatsApp (simulação). */
export const paceKey = (provider: string, accountJid: string | null | undefined) =>
  provider === 'baileys' && accountJid ? accountJid : null;

export async function lockAccount(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`INSERT IGNORE INTO \`WhatsAppAccount\` (id) VALUES (${id})`;
  await tx.$queryRaw`SELECT id FROM \`WhatsAppAccount\` WHERE id = ${id} FOR UPDATE`;
}

/** O número está livre para um envio de uma campanha com este intervalo? (sob lockAccount) */
async function accountAllows(tx: Prisma.TransactionClient, id: string, intervalSeconds: number, at: Date) {
  const account = await tx.whatsAppAccount.findUniqueOrThrow({ where: { id } });
  if (account.nextAvailableAt && account.nextAvailableAt > at) return false;
  // Vale o maior intervalo entre o envio anterior e o próximo: nenhum dos dois fica mais curto.
  if (account.lastSendEndedAt && account.lastSendEndedAt.getTime() + intervalSeconds * 1000 > at.getTime()) return false;
  return true;
}

// Reenvio automático (ADR-014): só de falhas em que é CERTO que nada chegou ao grupo (falha
// antes do sendMessage ou recusa do servidor). Envio de resultado incerto nunca é repetido.
export const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];

/** Quando tentar de novo depois da tentativa número `attempts`; null = esgotou. */
export function retryAt(attempts: number, at: Date): Date | null {
  if (attempts >= MAX_SEND_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
  return new Date(at.getTime() + delay);
}

// Cabeça da fila: o primeiro envio (por sequência) em andamento ou já vencido. Na criação os
// horários crescem com a sequência, então isto é a mesma cabeça de sempre; a diferença é que
// um reenvio agendado para mais tarde não trava os envios seguintes.
export const dueOrRunning = (at: Date) => ({
  OR: [{ status: 'PROCESSING' as const }, { status: 'PENDING' as const, scheduledAt: { lte: at } }],
});

// One durable claim per delivery. A crash after this point is deliberately NOT retried.
export async function claimDelivery(db: PrismaClient, id: string, now?: Date) {
  now ??= await currentTime();
  const at = now;
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const candidate = await tx.delivery.findUnique({ where: { id } });
    if (!candidate) return null;
    // O número é lido antes do lock (accountJid só muda na ativação de um rascunho) e
    // conferido de novo depois dele.
    const owner = await tx.campaign.findUnique({ where: { id: candidate.campaignId }, select: { accountJid: true } });
    const account = paceKey(candidate.provider, owner?.accountJid);
    if (account) await lockAccount(tx, account);
    await lockCampaign(tx, candidate.campaignId);
    const campaign = await tx.campaign.findUnique({ where: { id: candidate.campaignId } });
    if (!campaign || campaign.deletedAt || campaign.status !== 'ACTIVE' || (campaign.nextAvailableAt && campaign.nextAvailableAt > at)) return null;
    if (paceKey(candidate.provider, campaign.accountJid) !== account) return null;
    const head = await tx.delivery.findFirst({ where: { campaignId: campaign.id, ...dueOrRunning(at) }, orderBy: { sequence: 'asc' }, include: { group: true } });
    if (!head || head.id !== id || head.status !== 'PENDING' || head.scheduledAt > at) return null;
    if (account && !await accountAllows(tx, account, campaign.intervalSeconds, at)) return null;
    const claimed = await tx.delivery.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'PROCESSING', attemptedAt: at, updatedAt: at, error: null, attempts: { increment: 1 } } });
    if (!claimed.count) return null;
    const next = new Date(at.getTime() + campaign.intervalSeconds * 1000);
    await tx.campaign.update({ where: { id: campaign.id }, data: { nextAvailableAt: next, updatedAt: at } });
    // Número ocupado enquanto este envio está em andamento (e se o processo cair no meio).
    if (account) await tx.whatsAppAccount.update({ where: { id: account }, data: { nextAvailableAt: next } });
    return { ...head, campaign };
  }, LOCKING_TRANSACTION);
}

// Resultado do envio. context descreve o grupo no momento do envio; code é o código
// técnico da falha (ex.: status do Baileys), guardado à parte da mensagem legível.
// retryable = a falha aconteceu antes de qualquer coisa sair (ADR-014).
export type SendOutcome = ({ providerId: string } | { error: string; code?: string; retryable?: boolean }) & { context?: string };

export async function finishDelivery(db: PrismaClient, id: string, outcome: SendOutcome, now?: Date) {
  now ??= await currentTime();
  const at = now;
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const delivery = await tx.delivery.findUnique({ where: { id } });
    if (!delivery) return;
    const owner = await tx.campaign.findUnique({ where: { id: delivery.campaignId }, select: { accountJid: true } });
    const account = paceKey(delivery.provider, owner?.accountJid);
    if (account) await lockAccount(tx, account);
    await lockCampaign(tx, delivery.campaignId);
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: delivery.campaignId } });
    const context = outcome.context?.slice(0, 160);
    let data: Prisma.DeliveryUpdateManyMutationInput;
    if ('providerId' in outcome) {
      data = { status: 'SENT', providerId: outcome.providerId, sentAt: at, sendReturnedAt: at, updatedAt: at, error: null, errorCode: null, serverRejectedAt: null, sendContext: context };
    } else {
      const failure = { sendReturnedAt: at, updatedAt: at, errorCode: outcome.code?.slice(0, 64), sendContext: context };
      const retry = outcome.retryable && !campaign.deletedAt && ['ACTIVE', 'PAUSED'].includes(campaign.status) ? retryAt(delivery.attempts, at) : null;
      data = retry
        ? { ...failure, status: 'PENDING', scheduledAt: retry, error: outcome.error }
        : { ...failure, status: 'FAILED', error: outcome.retryable && delivery.attempts > 1 ? `Falhou nas ${delivery.attempts} tentativas. ${outcome.error}` : outcome.error };
    }
    const changed = await tx.delivery.updateMany({ where: { id, status: 'PROCESSING' }, data });
    if (!changed.count) return;
    // Full interval after completion, even after a slow send or a restart.
    const next = new Date(at.getTime() + campaign.intervalSeconds * 1000);
    await tx.campaign.update({ where: { id: campaign.id }, data: { nextAvailableAt: next, updatedAt: at, ...(campaign.status === 'PAUSED' ? { pausedAt: at } : {}) } });
    // O número também conta o intervalo a partir do fim desta tentativa (sucesso ou falha).
    if (account) await tx.whatsAppAccount.update({ where: { id: account }, data: { nextAvailableAt: next, lastSendEndedAt: at, lastIntervalSeconds: campaign.intervalSeconds } });
    const remaining = await tx.delivery.count({ where: { campaignId: campaign.id, status: { in: ['PENDING', 'PROCESSING'] } } });
    if (!remaining && ['ACTIVE', 'PAUSED'].includes(campaign.status)) await tx.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED', pausedAt: null, updatedAt: at } });
  }, LOCKING_TRANSACTION);
}

// Na partida, antes de marcar como incertos os envios que ficaram em andamento: não se sabe
// quando a mensagem interrompida saiu (pode ter sido um instante antes da queda), então o
// número espera um intervalo inteiro contado a partir de agora.
export async function holdInterruptedAccounts(db: PrismaClient, now: Date) {
  const interrupted = await db.delivery.findMany({
    where: { status: 'PROCESSING', provider: 'baileys' },
    select: { campaign: { select: { accountJid: true, intervalSeconds: true } } },
  });
  for (const { campaign } of interrupted) {
    const account = paceKey('baileys', campaign.accountJid);
    if (!account) continue;
    await db.$transaction(async tx => {
      await lockAccount(tx, account);
      const current = await tx.whatsAppAccount.findUniqueOrThrow({ where: { id: account } });
      const until = new Date(now.getTime() + campaign.intervalSeconds * 1000);
      await tx.whatsAppAccount.update({ where: { id: account }, data: {
        nextAvailableAt: current.nextAvailableAt && current.nextAvailableAt > until ? current.nextAvailableAt : until,
        lastSendEndedAt: now,
        lastIntervalSeconds: campaign.intervalSeconds,
      } });
    }, LOCKING_TRANSACTION);
  }
}
