import { DateTime } from 'luxon';
import { prisma, currentTime, TIME_ZONE } from '@campaign/database';
import type { WhatsAppManager } from './whatsapp-manager';

// Visão geral do sistema para o painel do SUPER_ADMIN (ADR-031). Só números agregados: nenhuma
// mensagem, nome de grupo ou conteúdo de campanha de ninguém passa por aqui.
export async function adminOverview(manager: Pick<WhatsAppManager, 'owners' | 'peek'>) {
  const serverNow = await currentTime();
  const today = DateTime.fromJSDate(serverNow, { zone: TIME_ZONE }).startOf('day');
  const period = { gte: today.toJSDate(), lt: today.plus({ days: 1 }).toJSDate() };
  const since = today.minus({ days: 6 });
  const offset = today.toFormat('ZZ');
  const real = { provider: 'baileys' as const };

  const {
    totalUsers, disabledUsers, admins, campaignsByStatus, sentToday, failedToday, deliveredToday,
    queueNow, sentByDay, failedByDay, topErrors, lease, pairedWhatsApps,
  } = await prisma.$transaction(async tx => {
    const [
      totalUsers, disabledUsers, admins, campaignsByStatus, sentToday, failedToday, deliveredToday,
      queueNow, sentByDay, failedByDay, topErrors, lease, pairedWhatsApps,
    ] = await Promise.all([
      tx.user.count(),
      tx.user.count({ where: { disabledAt: { not: null } } }),
      tx.user.count({ where: { role: 'SUPER_ADMIN', disabledAt: null } }),
      tx.campaign.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      tx.delivery.count({ where: { ...real, status: 'SENT', sentAt: period } }),
      tx.delivery.count({ where: { ...real, status: 'FAILED', updatedAt: period } }),
      tx.delivery.count({ where: { ...real, status: 'SENT', sentAt: period, deliveredAt: { not: null } } }),
      tx.delivery.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      tx.$queryRaw<{ day: Date; n: bigint }[]>`
        SELECT DATE(CONVERT_TZ(sentAt, '+00:00', ${offset})) AS day, COUNT(*) AS n
        FROM \`Delivery\` WHERE provider = 'baileys' AND status = 'SENT' AND sentAt >= ${since.toJSDate()}
        GROUP BY day`,
      tx.$queryRaw<{ day: Date; n: bigint }[]>`
        SELECT DATE(CONVERT_TZ(updatedAt, '+00:00', ${offset})) AS day, COUNT(*) AS n
        FROM \`Delivery\` WHERE provider = 'baileys' AND status = 'FAILED' AND updatedAt >= ${since.toJSDate()}
        GROUP BY day`,
      tx.delivery.groupBy({ by: ['errorCode'], where: { ...real, status: 'FAILED', errorCode: { not: null }, updatedAt: { gte: since.toJSDate() } }, _count: { _all: true }, orderBy: { _count: { errorCode: 'desc' } }, take: 5 }),
      tx.workerLease.findUnique({ where: { id: 'worker' } }),
      tx.whatsAppSession.count({ where: { accountJid: { not: null } } }),
    ]);
    return { totalUsers, disabledUsers, admins, campaignsByStatus, sentToday, failedToday, deliveredToday, queueNow, sentByDay, failedByDay, topErrors, lease, pairedWhatsApps };
  }, { isolationLevel: 'RepeatableRead' });

  const byStatus = (status: string) => campaignsByStatus.find(c => c.status === status)?._count._all ?? 0;
  const perDay = (rows: { day: Date; n: bigint }[]) => new Map(rows.map(r => [DateTime.fromJSDate(r.day, { zone: 'utc' }).toISODate(), Number(r.n)]));
  const sentPerDay = perDay(sentByDay);
  const failedPerDay = perDay(failedByDay);
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const day = since.plus({ days: i }).toISODate()!;
    return { day, sent: sentPerDay.get(day) ?? 0, failed: failedPerDay.get(day) ?? 0 };
  });
  // Conectado AGORA (memória do processo), não só o último estado gravado no banco.
  const connectedNow = manager.owners().filter(id => manager.peek(id)?.status().state === 'connected').length;
  const mem = process.memoryUsage();

  return {
    serverNow, timezone: TIME_ZONE,
    users: { total: totalUsers, active: totalUsers - disabledUsers, disabled: disabledUsers, admins },
    campaigns: { total: campaignsByStatus.reduce((sum, c) => sum + c._count._all, 0), active: byStatus('ACTIVE'), paused: byStatus('PAUSED'), draft: byStatus('DRAFT'), completed: byStatus('COMPLETED'), cancelled: byStatus('CANCELLED') },
    today: { sent: sentToday, failed: failedToday, delivered: deliveredToday, deliveryRate: sentToday ? Math.round(100 * deliveredToday / sentToday) : null, successRate: sentToday + failedToday ? Math.round(100 * sentToday / (sentToday + failedToday)) : null },
    queueNow, last7Days, topErrorCodes: topErrors.map(e => ({ code: e.errorCode!, count: e._count._all })),
    whatsapp: { connectedNow, paired: pairedWhatsApps },
    dispatcher: lease ? { ownerId: lease.ownerId, active: lease.expiresAt > serverNow, expiresAt: lease.expiresAt } : { ownerId: null, active: false, expiresAt: null },
    process: { uptimeSeconds: Math.round(process.uptime()), memoryMb: { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) } },
  };
}
