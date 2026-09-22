import { DateTime } from 'luxon';
import { prisma, currentTime, TIME_ZONE } from '@campaign/database';

export async function dashboardSummary() {
  const serverNow = await currentTime();
  const today = DateTime.fromJSDate(serverNow, { zone: TIME_ZONE }).startOf('day');
  const period = { gte: today.toJSDate(), lt: today.plus({ days: 1 }).toJSDate() };
  // A dashboard is read-only. No completion, scheduling or delivery mutations.
  return prisma.$transaction(async tx => {
    const [sentToday, failedToday, sent, failed, readsToday, readsPrevious, candidates, counts, recentSent, recentFailed] = await Promise.all([
      tx.delivery.count({ where: { provider: 'baileys', status: 'SENT', sentAt: period } }),
      tx.delivery.count({ where: { provider: 'baileys', status: 'FAILED', updatedAt: period } }),
      tx.delivery.count({ where: { provider: 'baileys', status: 'SENT' } }),
      tx.delivery.count({ where: { provider: 'baileys', status: 'FAILED' } }),
      tx.deliveryRead.count({ where: { readAt: period, delivery: { provider: 'baileys', status: 'SENT' } } }),
      tx.deliveryRead.count({ where: { readAt: { gte: today.minus({ days: 1 }).toJSDate(), lt: period.gte }, delivery: { provider: 'baileys', status: 'SENT' } } }),
      tx.campaign.findMany({ where: { status: 'ACTIVE', deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, provider: true, nextAvailableAt: true, deliveries: { where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }], take: 1, select: { id: true, campaignId: true, provider: true, status: true, scheduledAt: true, group: { select: { name: true } } } } } }),
      tx.delivery.groupBy({ by: ['campaignId', 'status'], where: { campaign: { status: 'ACTIVE', deletedAt: null } }, _count: { _all: true } }),
      tx.delivery.findMany({ where: { provider: 'baileys', status: 'SENT', sentAt: { not: null } }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: 8, select: { id: true, campaignId: true, sentAt: true, group: { select: { name: true } }, campaign: { select: { name: true, deletedAt: true } } } }),
      tx.delivery.findMany({ where: { provider: 'baileys', status: 'FAILED' }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 8, select: { id: true, campaignId: true, updatedAt: true, group: { select: { name: true } }, campaign: { select: { name: true, deletedAt: true } } } })
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
    ].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id)).slice(0, 8);
    return { serverNow, activeCampaigns: candidates.length, sentToday, failedToday, sent, failed, readsToday, readsPrevious, successRate: sentToday + failedToday ? Math.round(100 * sentToday / (sentToday + failedToday)) : null, nextDelivery, runningCampaigns, recentActivity };
  }, { isolationLevel: 'RepeatableRead' });
}
