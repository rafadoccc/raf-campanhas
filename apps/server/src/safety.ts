import type { Prisma } from '@prisma/client';
import { prisma, lockCampaign, LOCKING_TRANSACTION, rulesFor, resumeAt } from '@campaign/database';
import { assertCanSend, assertGroupLimit } from './plans';

// Pausa automática por sinal de restrição (ADR-041, T-135). Continuar mandando depois de o
// WhatsApp dar um aviso é o caminho mais curto para o banimento. Ao ver um sinal, pausa TODAS as
// campanhas reais ativas da conta e deixa um aviso no painel. Restrição real exige retomada
// manual. Só um falso alarme comprovado por entregas pode ser desfeito sozinho (ADR-053).

/** Recusas do servidor numa hora que disparam a pausa, depois do envio. */
export const REJECTIONS_TO_PAUSE = 3;
const REJECTION_WINDOW_MS = 60 * 60_000;

export const SAFETY_REASONS = {
  forbidden: 'O WhatsApp recusou o número (código 403), o que pode ser uma restrição. Pausamos as campanhas: confira no celular e espere 24 horas antes de retomar.',
  rateLimited: 'O WhatsApp limitou os envios deste número por excesso de mensagens. Pausamos as campanhas: espere algumas horas antes de retomar.',
  rejections: (n: number) => `O WhatsApp recusou ${n} mensagens na última hora. Pausamos as campanhas por segurança: confira no celular antes de retomar.`,
};

/** Pausa as campanhas reais ativas da conta e registra o aviso. Devolve quantas pausou. */
export async function safetyPause(ownerId: string, reason: string, now = new Date(), verifyRejections = false) {
  if (!(await rulesFor(prisma, ownerId)).autoPause) return 0;
  const paused = await prisma.$transaction(async tx => {
    // Mesma ordem da retomada e das alterações de plano: dono, depois campanhas por id.
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${ownerId} FOR UPDATE`;
    const campaigns = await tx.campaign.findMany({ where: {
      userId: ownerId, provider: 'baileys',
      OR: [
        { status: 'ACTIVE', deletedAt: null },
        ...(verifyRejections ? [{ deliveries: { some: { serverRejectedAt: { gt: new Date(now.getTime() - REJECTION_WINDOW_MS), lte: now } } } }] : []),
      ],
    }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const { id } of campaigns) await lockCampaign(tx, id);
    if (verifyRejections) {
      const session = await tx.whatsAppSession.findUnique({ where: { userId: ownerId } });
      // Uma recusa genérica nunca substitui um aviso explícito de restrição/limite.
      if (session?.safetyReason === SAFETY_REASONS.forbidden || session?.safetyReason === SAFETY_REASONS.rateLimited) return null;
      // Recibos podem chegar entre a consulta inicial e a pausa. Revalida sob os mesmos
      // locks usados por applyServerEvent; um recibo já confirmado ganha da recusa.
      const n = await unresolvedRejections(tx, ownerId, now);
      if (n < REJECTIONS_TO_PAUSE) return null;
      reason = SAFETY_REASONS.rejections(n);
    }
    const active = await tx.campaign.findMany({ where: { userId: ownerId, status: 'ACTIVE', deletedAt: null, provider: 'baileys' }, select: { id: true } });
    let count = 0;
    for (const { id } of active) {
      // Mesma pausa do botão Pausar: o envio em andamento termina e registra pausedAt.
      count += (await tx.campaign.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedAt: now, updatedAt: now } })).count;
    }
    await tx.whatsAppSession.upsert({ where: { userId: ownerId }, update: { safetyPausedAt: now, safetyReason: reason.slice(0, 255) }, create: { userId: ownerId, safetyPausedAt: now, safetyReason: reason.slice(0, 255) } });
    return count;
  }, LOCKING_TRANSACTION);
  if (paused === null) return 0;
  console.warn('[Proteção] Campanhas pausadas automaticamente:', ownerId, `(${paused})`, reason);
  return paused;
}

async function unresolvedRejections(tx: Prisma.TransactionClient, ownerId: string, now: Date) {
  const since = new Date(now.getTime() - REJECTION_WINDOW_MS);
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM \`Delivery\` d
    JOIN \`Campaign\` c ON c.id = d.campaignId
    LEFT JOIN \`WhatsAppSession\` s ON s.userId = c.userId
    WHERE c.userId = ${ownerId} AND d.provider = 'baileys'
      AND d.serverRejectedAt > ${since} AND d.serverRejectedAt <= ${now}
      AND d.deliveredAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM \`DeliveryRead\` r WHERE r.deliveryId = d.id)
      AND (s.safetyPausedAt IS NULL OR d.serverRejectedAt > s.safetyPausedAt)`;
  return Number(rows[0].n);
}

/**
 * Não reinicia campanhas nem refaz entregas. Desfaz exclusivamente uma pausa por recusas
 * quando TODAS as recusas daquela janela têm entrega confirmada e a campanha não sofreu
 * outra alteração desde a pausa. Sem provas, sem conexão ou com restrição 403/429: manual.
 */
export async function recoverConfirmedRejections(connectedAccount: (ownerId: string) => string | null, now = new Date()) {
  const sessions = await prisma.whatsAppSession.findMany({ where: { safetyPausedAt: { not: null }, safetyReason: { startsWith: 'O WhatsApp recusou ' } } });
  let resumed = 0;
  for (const original of sessions) {
    const match = /^O WhatsApp recusou (\d+) mensagens na última hora\./.exec(original.safetyReason ?? '');
    if (!match || Number(match[1]) < REJECTIONS_TO_PAUSE || !original.accountJid || connectedAccount(original.userId) !== original.accountJid) continue;
    resumed += await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${original.userId} FOR UPDATE`;
      const campaigns = await tx.campaign.findMany({ where: {
        userId: original.userId, provider: 'baileys',
        OR: [
          { status: 'PAUSED' },
          { deliveries: { some: { serverRejectedAt: { gt: new Date(original.safetyPausedAt!.getTime() - REJECTION_WINDOW_MS), lte: now } } } },
        ],
      }, select: { id: true }, orderBy: { id: 'asc' } });
      for (const { id } of campaigns) await lockCampaign(tx, id);
      const session = await tx.whatsAppSession.findUnique({ where: { userId: original.userId } });
      if (!session?.safetyPausedAt || session.safetyReason !== original.safetyReason || session.safetyPausedAt.getTime() !== original.safetyPausedAt!.getTime() || session.accountJid !== original.accountJid) return 0;
      if (connectedAccount(original.userId) !== session.accountJid) return 0;
      const user = await tx.user.findUnique({ where: { id: original.userId }, select: { disabledAt: true } });
      if (!user || user.disabledAt) return 0;
      try { await assertCanSend(original.userId, now, tx); } catch { return 0; }
      // Se alguém retomou outra campanha ou uma tentativa terminou depois da pausa, pode
      // ter substituído ids/sinais antigos. Não atribui esses sucessos a um falso alarme.
      if (await tx.delivery.findFirst({ where: {
        provider: 'baileys', campaign: { userId: original.userId }, sentAt: { gt: session.safetyPausedAt },
      }, select: { id: true } })) return 0;
      // Usa a janela ORIGINAL da pausa, não "a última hora de agora". O simples passar
      // do tempo jamais é prova de entrega. Retentativa com outro id não substitui a prova.
      const rejected = await tx.delivery.findMany({ where: {
        provider: 'baileys', campaign: { userId: original.userId },
        serverRejectedAt: { gt: new Date(session.safetyPausedAt.getTime() - REJECTION_WINDOW_MS), lte: now },
      }, select: { status: true, deliveredAt: true, serverRejectedAt: true, errorCode: true } });
      // Uma recusa posterior ou entrega confirmada antes da pausa não pode substituir a
      // prova de um dos sinais originais (que pode ter sumido numa retentativa). Para pausas
      // antigas sem identificação suficiente dos sinais, a saída segura continua manual.
      const originalProofs = rejected.filter(d => d.serverRejectedAt! <= session.safetyPausedAt! && d.deliveredAt && d.deliveredAt >= session.safetyPausedAt! && d.deliveredAt <= now);
      if (originalProofs.length < Number(match[1]) || rejected.some(d => d.status !== 'SENT' || !d.deliveredAt || /^(servidor|baileys):(403|429)$/.test(d.errorCode ?? ''))) return 0;
      const paused = await tx.campaign.findMany({ where: {
        userId: original.userId, provider: 'baileys', accountJid: session.accountJid,
        status: 'PAUSED', deletedAt: null, isTemplate: false,
        pausedAt: session.safetyPausedAt, updatedAt: session.safetyPausedAt,
        deliveries: { some: { status: 'PENDING' }, none: { status: 'PROCESSING' } },
      }, include: { groups: { include: { group: true } } } });
      let count = 0;
      for (const campaign of paused) {
        if (campaign.groups.some(g => !g.group.active || !g.group.externalId?.endsWith('@g.us'))) continue;
        try { await assertGroupLimit(original.userId, campaign.groups.length, now, tx); } catch { continue; }
        await tx.campaign.update({ where: { id: campaign.id }, data: {
          status: 'ACTIVE', pausedAt: null, updatedAt: now,
          nextAvailableAt: resumeAt(campaign.nextAvailableAt, campaign.pausedAt, now),
        } });
        count++;
      }
      // Conserva a marca temporal para as recusas antigas não pausarem de novo.
      await tx.whatsAppSession.update({ where: { userId: original.userId }, data: { safetyReason: null } });
      await tx.ownerAlert.updateMany({ where: {
        userId: original.userId, key: `pausa:${original.userId}:${session.safetyPausedAt.getTime()}`,
        sentAt: null, error: null,
      }, data: { error: 'Não enviado: falso alarme resolvido por confirmação de entrega.' } });
      return count;
    }, { ...LOCKING_TRANSACTION, timeout: 30_000 });
  }
  if (resumed) console.info('[Proteção] Falso alarme desfeito após confirmação de entrega:', resumed, 'campanha(s) retomada(s).');
  return resumed;
}

/** Erro de envio que é o WhatsApp limitando o número (e não uma falha qualquer). */
export const isRateLimit = (error: unknown, code: string | undefined) =>
  code === 'baileys:429' || /rate-?overlimit|too many/i.test(error instanceof Error ? error.message : '');

/**
 * Contas com recusas demais do servidor na última hora, contadas só depois da última pausa
 * automática (as mesmas recusas não pausam de novo depois que a pessoa retoma).
 */
export async function checkRejections(now = new Date()) {
  const since = new Date(now.getTime() - REJECTION_WINDOW_MS);
  const rows = await prisma.$queryRaw<{ userId: string; n: bigint }[]>`
    SELECT c.userId AS userId, COUNT(*) AS n
    FROM \`Delivery\` d
    JOIN \`Campaign\` c ON c.id = d.campaignId
    LEFT JOIN \`WhatsAppSession\` s ON s.userId = c.userId
    WHERE d.provider = 'baileys' AND d.serverRejectedAt > ${since} AND d.serverRejectedAt <= ${now}
      AND d.deliveredAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM \`DeliveryRead\` r WHERE r.deliveryId = d.id)
      AND (s.safetyPausedAt IS NULL OR d.serverRejectedAt > s.safetyPausedAt)
    GROUP BY c.userId
    HAVING COUNT(*) >= ${REJECTIONS_TO_PAUSE}`;
  for (const row of rows) await safetyPause(row.userId, SAFETY_REASONS.rejections(Number(row.n)), now, true).catch(error => {
    console.error('[Proteção] Não foi possível pausar:', row.userId, error instanceof Error ? error.message : error);
  });
  return rows.length;
}
