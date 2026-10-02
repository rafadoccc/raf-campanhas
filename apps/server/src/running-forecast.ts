import { prisma, paceKey, minimumInterval, rulesFor, sendsToday, MAX_SEND_ATTEMPTS } from '@campaign/database';
import { forecastQueue, waitKind, type ForecastRules, type WaitKind } from './queue-forecast';

// Situação REAL do próximo envio de cada campanha em andamento, para o bloco "Em andamento" do
// Início. Usa a mesma previsão do detalhe da campanha (queue-forecast.ts): horário de silêncio,
// limite do dia, intervalo por grupo, WhatsApp desconectado e o relógio do número. Antes, o
// Início dizia "saindo agora" para um envio que só sairia às 8h do dia seguinte.

type Running = { id: string; userId: string; status: string; provider: string; accountJid: string | null; nextAvailableAt: Date | null; intervalSeconds: number };
export type NextSend = { group: string; expectedAt: Date; reason: string | null; kind: WaitKind };

/** Quantos envios da frente da fila entram na conta: o próximo e os vizinhos que podem passar na frente. */
const HEAD = 5;

export async function nextSends(campaigns: Running[], connected: boolean, now: Date) {
  const result = new Map<string, NextSend>();
  for (const campaign of campaigns) {
    const items = await prisma.delivery.findMany({
      where: { campaignId: campaign.id, status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { sequence: 'asc' },
      take: HEAD,
      select: { id: true, status: true, sequence: true, provider: true, scheduledAt: true, attemptedAt: true, attempts: true, groupId: true, group: { select: { name: true } } },
    });
    if (!items.length) continue;
    // O número pode estar ocupado por outra campanha (ADR-006): a previsão parte do mais tarde dos dois relógios.
    const accountId = paceKey(campaign.provider, campaign.accountJid);
    const account = accountId ? await prisma.whatsAppAccount.findUnique({ where: { id: accountId } }) : null;
    const numberFreeAt = Math.max(account?.nextAvailableAt?.getTime() ?? 0, account?.lastSendEndedAt ? account.lastSendEndedAt.getTime() + minimumInterval(campaign.intervalSeconds) * 1000 : 0);
    const paced = { ...campaign, nextAvailableAt: new Date(Math.max(campaign.nextAvailableAt?.getTime() ?? 0, numberFreeAt)) };
    // Regras da conta (ADR-041) só pesam em envio real, pelo número da campanha.
    let limits: ForecastRules | undefined;
    if (accountId) {
      const rules = await rulesFor(prisma, campaign.userId, accountId);
      const groupIds = [...new Set(items.map(item => item.groupId))];
      const [usedToday, lastSent] = await Promise.all([
        rules.dailyLimit || rules.warmupStartedAt ? sendsToday(prisma, accountId, now) : 0,
        rules.groupGapMinutes ? prisma.delivery.groupBy({ by: ['groupId'], where: { groupId: { in: groupIds }, status: 'SENT', provider: 'baileys' }, _max: { sentAt: true } }) : [],
      ]);
      limits = { rules, usedToday, lastSentByGroup: new Map(lastSent.flatMap(row => (row._max.sentAt ? [[row.groupId, row._max.sentAt] as const] : []))) };
    }
    const forecast = forecastQueue(items, paced, now, connected, MAX_SEND_ATTEMPTS, limits);
    // O próximo é o que está saindo agora ou, entre os pendentes, o de previsão mais cedo.
    const head = items.find(item => item.status === 'PROCESSING')
      ?? items.filter(item => forecast.has(item.id)).sort((a, b) => forecast.get(a.id)!.expectedAt.getTime() - forecast.get(b.id)!.expectedAt.getTime())[0];
    const wait = head && forecast.get(head.id);
    if (head && wait) result.set(campaign.id, { group: head.group.name, expectedAt: wait.expectedAt, reason: wait.reason, kind: waitKind(wait, head.status) });
  }
  return result;
}
