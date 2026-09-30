import { prisma, lockCampaign, LOCKING_TRANSACTION, rulesFor } from '@campaign/database';

// Pausa automática por sinal de restrição (ADR-041, T-135). Continuar mandando depois de o
// WhatsApp dar um aviso é o caminho mais curto para o banimento. Ao ver um sinal, pausa TODAS as
// campanhas reais ativas da conta e deixa um aviso no painel. Retomar é sempre manual.

/** Recusas do servidor numa hora que disparam a pausa (grupos diferentes, depois do envio). */
export const REJECTIONS_TO_PAUSE = 3;
const REJECTION_WINDOW_MS = 60 * 60_000;

export const SAFETY_REASONS = {
  forbidden: 'O WhatsApp recusou o número (código 403), o que pode ser uma restrição. Pausamos as campanhas: confira no celular e espere 24 horas antes de retomar.',
  rateLimited: 'O WhatsApp limitou os envios deste número por excesso de mensagens. Pausamos as campanhas: espere algumas horas antes de retomar.',
  rejections: (n: number) => `O WhatsApp recusou ${n} mensagens na última hora. Pausamos as campanhas por segurança: confira no celular antes de retomar.`,
};

/** Pausa as campanhas reais ativas da conta e registra o aviso. Devolve quantas pausou. */
export async function safetyPause(ownerId: string, reason: string, now = new Date()) {
  if (!(await rulesFor(prisma, ownerId)).autoPause) return 0;
  const paused = await prisma.$transaction(async tx => {
    const active = await tx.campaign.findMany({ where: { userId: ownerId, status: 'ACTIVE', deletedAt: null, provider: 'baileys' }, select: { id: true }, orderBy: { id: 'asc' } });
    let count = 0;
    for (const { id } of active) {
      await lockCampaign(tx, id);
      // Mesma pausa do botão Pausar: o envio em andamento termina e registra pausedAt.
      count += (await tx.campaign.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedAt: now, updatedAt: now } })).count;
    }
    await tx.whatsAppSession.upsert({ where: { userId: ownerId }, update: { safetyPausedAt: now, safetyReason: reason.slice(0, 255) }, create: { userId: ownerId, safetyPausedAt: now, safetyReason: reason.slice(0, 255) } });
    return count;
  }, LOCKING_TRANSACTION);
  console.warn('[Proteção] Campanhas pausadas automaticamente:', ownerId, `(${paused})`, reason);
  return paused;
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
    WHERE d.provider = 'baileys' AND d.serverRejectedAt > ${since}
      AND (s.safetyPausedAt IS NULL OR d.serverRejectedAt > s.safetyPausedAt)
    GROUP BY c.userId
    HAVING COUNT(*) >= ${REJECTIONS_TO_PAUSE}`;
  for (const row of rows) await safetyPause(row.userId, SAFETY_REASONS.rejections(Number(row.n)), now).catch(error => {
    console.error('[Proteção] Não foi possível pausar:', row.userId, error instanceof Error ? error.message : error);
  });
  return rows.length;
}
