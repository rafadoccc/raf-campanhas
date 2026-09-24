import { DateTime } from 'luxon';
import { prisma, currentTime, TIME_ZONE } from '@campaign/database';

// Tudo escopado pelas campanhas do usuário (ADR-018): o painel de um nunca conta o de outro.
export async function dashboardSummary(userId: string) {
  const serverNow = await currentTime();
  const today = DateTime.fromJSDate(serverNow, { zone: TIME_ZONE }).startOf('day');
  const period = { gte: today.toJSDate(), lt: today.plus({ days: 1 }).toJSDate() };
  const mine = { userId };
  const sentToday = { campaign: mine, provider: 'baileys', status: 'SENT' as const, sentAt: period };
  // Últimos 7 dias (hoje incluso), no fuso de Brasília, para o gráfico de barras.
  const since = today.minus({ days: 6 });
  const offset = today.toFormat('ZZ');
  // A dashboard is read-only. No completion, scheduling or delivery mutations.
  return prisma.$transaction(async tx => {
    const [sentTodayCount, failedToday, sent, failed, readsToday, readsPrevious, candidates, counts, recentSent, recentFailed, deliveredToday, reachedToday, byDay] = await Promise.all([
      tx.delivery.count({ where: sentToday }),
      tx.delivery.count({ where: { campaign: mine, provider: 'baileys', status: 'FAILED', updatedAt: period } }),
      tx.delivery.count({ where: { campaign: mine, provider: 'baileys', status: 'SENT' } }),
      tx.delivery.count({ where: { campaign: mine, provider: 'baileys', status: 'FAILED' } }),
      tx.deliveryRead.count({ where: { readAt: period, delivery: { campaign: mine, provider: 'baileys', status: 'SENT' } } }),
      tx.deliveryRead.count({ where: { readAt: { gte: today.minus({ days: 1 }).toJSDate(), lt: period.gte }, delivery: { campaign: mine, provider: 'baileys', status: 'SENT' } } }),
      tx.campaign.findMany({ where: { userId, status: 'ACTIVE', deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, provider: true, nextAvailableAt: true, deliveries: { where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }], take: 1, select: { id: true, campaignId: true, provider: true, status: true, scheduledAt: true, group: { select: { name: true } } } } } }),
      tx.delivery.groupBy({ by: ['campaignId', 'status'], where: { campaign: { userId, status: 'ACTIVE', deletedAt: null } }, _count: { _all: true } }),
      tx.delivery.findMany({ where: { campaign: mine, provider: 'baileys', status: 'SENT', sentAt: { not: null } }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, campaignId: true, sentAt: true, deliveredAt: true, group: { select: { name: true } }, campaign: { select: { name: true, deletedAt: true } } } }),
      tx.delivery.findMany({ where: { campaign: mine, provider: 'baileys', status: 'FAILED' }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, campaignId: true, updatedAt: true, group: { select: { name: true } }, campaign: { select: { name: true, deletedAt: true } } } }),
      // Entregues hoje: enviados hoje que já têm recibo de entrega de algum membro.
      tx.delivery.count({ where: { ...sentToday, deliveredAt: { not: null } } }),
      // Alcance de hoje: grupos distintos e a soma dos membros deles.
      tx.delivery.findMany({ where: sentToday, distinct: ['groupId'], select: { group: { select: { participants: true } } } }),
      tx.$queryRaw<{ day: Date; n: bigint }[]>`
        SELECT DATE(CONVERT_TZ(d.\`sentAt\`, '+00:00', ${offset})) AS day, COUNT(*) AS n
        FROM \`Delivery\` d JOIN \`Campaign\` c ON c.id = d.\`campaignId\`
        WHERE c.\`userId\` = ${userId} AND d.provider = 'baileys' AND d.status = 'SENT' AND d.\`sentAt\` >= ${since.toJSDate()}
        GROUP BY day`,
    ]);
    const runningCampaigns = candidates.map(c => {
      const progress = counts.filter(row => row.campaignId === c.id);
      const head = c.deliveries[0];
      const nextDelivery = head ? { ...head, campaign: { name: c.name }, nextAt: new Date(Math.max(head.scheduledAt.getTime(), c.nextAvailableAt?.getTime() ?? 0)) } : null;
      return { id: c.id, name: c.name, provider: c.provider, sent: progress.find(row => row.status === 'SENT')?._count._all ?? 0, total: progress.reduce((sum, row) => sum + row._count._all, 0), nextDelivery };
    });
    const nextDelivery = runningCampaigns.flatMap(c => c.nextDelivery && c.nextDelivery.status === 'PENDING' ? [c.nextDelivery] : []).sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())[0] ?? null;
    const recentActivity = [
      ...recentSent.map(d => ({ ...d, status: 'SENT', at: d.sentAt! })),
      ...recentFailed.map(d => ({ ...d, status: 'FAILED', at: d.updatedAt }))
    ].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id)).slice(0, 20);
    const perDay = new Map(byDay.map(row => [DateTime.fromJSDate(row.day, { zone: 'utc' }).toISODate(), Number(row.n)]));
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const day = since.plus({ days: i }).toISODate()!;
      return { day, sent: perDay.get(day) ?? 0 };
    });
    const pendingNow = counts.filter(row => row.status === 'PENDING' || row.status === 'PROCESSING').reduce((sum, row) => sum + row._count._all, 0);
    return {
      serverNow, activeCampaigns: candidates.length, sentToday: sentTodayCount, failedToday, sent, failed, readsToday, readsPrevious,
      successRate: sentTodayCount + failedToday ? Math.round(100 * sentTodayCount / (sentTodayCount + failedToday)) : null,
      deliveredToday, deliveryRate: sentTodayCount ? Math.round(100 * deliveredToday / sentTodayCount) : null,
      groupsReachedToday: reachedToday.length, membersReachedToday: reachedToday.reduce((sum, row) => sum + (row.group.participants ?? 0), 0),
      pendingNow, last7Days, nextDelivery, runningCampaigns, recentActivity,
    };
  }, { isolationLevel: 'RepeatableRead' });
}
