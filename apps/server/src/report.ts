import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { prisma, campaignReads, currentTime, completeFinished, TIME_ZONE } from '@campaign/database';

// Relatório da campanha (ADR-045): os NÚMEROS, para o dono mostrar o resultado. O mesmo
// relatório serve à tela do dono (com login) e ao link público (sem login, por um código que o
// dono cria e desativa). O link nunca mostra o texto das mensagens, a mídia, telefones nem ids
// internos: só nome da campanha, período, grupos (nome e tamanho) e contagens.

const num = (value: bigint | number | null | undefined) => Number(value ?? 0);
const rate = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : null);

async function buildReport(campaignId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: {
      name: true, status: true, mode: true, startsAt: true, endsAt: true, createdAt: true, mentionAll: true,
      schedules: { orderBy: { time: 'asc' }, select: { time: true } },
      groups: { orderBy: { position: 'asc' }, select: { group: { select: { id: true, name: true, participants: true } } } },
    },
  });
  if (!campaign) return null;
  const now = await currentTime();
  const offset = DateTime.fromJSDate(now, { zone: TIME_ZONE }).toFormat('ZZ');
  const [perGroup, reads, perDay] = await Promise.all([
    prisma.$queryRaw<{ groupId: string; total: bigint; sent: bigint; delivered: bigint; failed: bigint; pending: bigint }[]>`
      SELECT d.\`groupId\` AS groupId, COUNT(*) AS total,
             SUM(d.status = 'SENT') AS sent,
             SUM(d.status = 'SENT' AND d.\`deliveredAt\` IS NOT NULL) AS delivered,
             SUM(d.status = 'FAILED') AS failed,
             SUM(d.status IN ('PENDING', 'PROCESSING')) AS pending
      FROM \`Delivery\` d WHERE d.\`campaignId\` = ${campaignId} GROUP BY d.\`groupId\``,
    campaignReads(prisma, campaignId),
    prisma.$queryRaw<{ day: Date; sent: bigint; delivered: bigint }[]>`
      SELECT DATE(CONVERT_TZ(d.\`sentAt\`, '+00:00', ${offset})) AS day, COUNT(*) AS sent,
             SUM(d.\`deliveredAt\` IS NOT NULL) AS delivered
      FROM \`Delivery\` d WHERE d.\`campaignId\` = ${campaignId} AND d.status = 'SENT' AND d.\`sentAt\` IS NOT NULL
      GROUP BY day ORDER BY day`,
  ]);
  const byGroup = campaign.groups.map(({ group }) => {
    const row = perGroup.find(r => r.groupId === group.id);
    return {
      name: group.name, participants: group.participants,
      sent: num(row?.sent), delivered: num(row?.delivered), failed: num(row?.failed), pending: num(row?.pending),
      reads: reads.find(r => r.groupId === group.id)?.count ?? 0,
    };
  });
  const sum = (key: 'sent' | 'delivered' | 'failed' | 'pending' | 'reads') => byGroup.reduce((total, g) => total + g[key], 0);
  const reached = byGroup.filter(g => g.sent > 0);
  const sent = sum('sent'); const delivered = sum('delivered'); const failed = sum('failed');
  return {
    generatedAt: now,
    campaign: {
      name: campaign.name, status: campaign.status, mode: campaign.mode, startsAt: campaign.startsAt, endsAt: campaign.endsAt,
      createdAt: campaign.createdAt, mentionAll: campaign.mentionAll, times: campaign.schedules.map(s => s.time),
    },
    totals: {
      groups: byGroup.length, groupsReached: reached.length,
      // Alcance: soma dos membros dos grupos que receberam ao menos um envio.
      membersReached: reached.reduce((total, g) => total + (g.participants ?? 0), 0),
      sent, delivered, failed, pending: sum('pending'), reads: sum('reads'),
      deliveryRate: rate(delivered, sent), successRate: rate(sent, sent + failed),
    },
    byGroup: [...byGroup].sort((a, b) => b.reads - a.reads || b.sent - a.sent || a.name.localeCompare(b.name)),
    byDay: perDay.map(row => ({ day: DateTime.fromJSDate(row.day, { zone: 'utc' }).toISODate()!, sent: num(row.sent), delivered: num(row.delivered) })),
  };
}

/** Números de um dia da conta (o clique numa barra do gráfico do Início). */
export async function daySummary(userId: string, day: string) {
  const start = DateTime.fromISO(day, { zone: TIME_ZONE }).startOf('day');
  const period = { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() };
  const offset = start.toFormat('ZZ');
  const mine = { userId };
  const sentThatDay = { campaign: mine, provider: 'baileys', status: 'SENT' as const, sentAt: period };
  const [sent, delivered, failed, reads, reached, perCampaign, perHour] = await Promise.all([
    prisma.delivery.count({ where: sentThatDay }),
    prisma.delivery.count({ where: { ...sentThatDay, deliveredAt: { not: null } } }),
    prisma.delivery.count({ where: { campaign: mine, provider: 'baileys', status: 'FAILED', updatedAt: period } }),
    prisma.deliveryRead.count({ where: { readAt: period, delivery: { campaign: mine, provider: 'baileys', status: 'SENT' } } }),
    prisma.delivery.findMany({ where: sentThatDay, distinct: ['groupId'], select: { group: { select: { participants: true } } } }),
    prisma.$queryRaw<{ id: string; name: string; sent: bigint; delivered: bigint }[]>`
      SELECT c.id AS id, c.name AS name, COUNT(*) AS sent, SUM(d.\`deliveredAt\` IS NOT NULL) AS delivered
      FROM \`Delivery\` d JOIN \`Campaign\` c ON c.id = d.\`campaignId\`
      WHERE c.\`userId\` = ${userId} AND c.\`deletedAt\` IS NULL AND d.provider = 'baileys' AND d.status = 'SENT'
        AND d.\`sentAt\` >= ${period.gte} AND d.\`sentAt\` < ${period.lt}
      GROUP BY c.id, c.name ORDER BY sent DESC`,
    prisma.$queryRaw<{ hour: number | bigint; sent: bigint }[]>`
      SELECT HOUR(CONVERT_TZ(d.\`sentAt\`, '+00:00', ${offset})) AS hour, COUNT(*) AS sent
      FROM \`Delivery\` d JOIN \`Campaign\` c ON c.id = d.\`campaignId\`
      WHERE c.\`userId\` = ${userId} AND d.provider = 'baileys' AND d.status = 'SENT'
        AND d.\`sentAt\` >= ${period.gte} AND d.\`sentAt\` < ${period.lt}
      GROUP BY hour`,
  ]);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: num(perHour.find(row => Number(row.hour) === hour)?.sent) }));
  return {
    day, sent, delivered, failed, reads,
    deliveryRate: rate(delivered, sent), successRate: rate(sent, sent + failed),
    groupsReached: reached.length, membersReached: reached.reduce((total, row) => total + (row.group.participants ?? 0), 0),
    campaigns: perCampaign.map(row => ({ id: row.id, name: row.name, sent: num(row.sent), delivered: num(row.delivered) })),
    hours,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
/** Até onde o gráfico volta: o mesmo prazo de guarda das campanhas (ADR-040). */
const DAY_LOOKBACK = 180;

export function registerReportRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/day', async (request, reply) => {
    const date = (request.query as { date?: unknown }).date;
    if (typeof date !== 'string' || !DAY.test(date) || !DateTime.fromISO(date, { zone: TIME_ZONE }).isValid) return reply.code(400).send({ error: 'Dia inválido.' });
    const today = DateTime.fromJSDate(await currentTime(), { zone: TIME_ZONE }).startOf('day');
    const asked = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day');
    if (asked > today || asked < today.minus({ days: DAY_LOOKBACK })) return reply.code(400).send({ error: 'Dia fora do período disponível.' });
    return daySummary(request.user!.id, date);
  });

  // Relatório do dono: só campanha própria; de outro usuário responde igual a inexistente.
  const owned = (id: string, userId: string) => prisma.campaign.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true, reportToken: true } });

  app.get('/api/campaigns/:id/report', async (request, reply) => {
    await completeFinished(prisma);
    const campaign = await owned((request.params as { id: string }).id, request.user!.id);
    const report = campaign && await buildReport(campaign.id);
    if (!campaign || !report) return reply.code(404).send({ error: 'Campanha não encontrada.' });
    return { ...report, shareToken: campaign.reportToken };
  });

  // Cria o link (ou devolve o que já existe: o mesmo link continua valendo).
  app.post('/api/campaigns/:id/report/share', async (request, reply) => {
    const campaign = await owned((request.params as { id: string }).id, request.user!.id);
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada.' });
    if (campaign.reportToken) return { shareToken: campaign.reportToken };
    const shareToken = randomBytes(24).toString('base64url');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { reportToken: shareToken } });
    return { shareToken };
  });

  // Desativa o link: quem tinha o endereço deixa de ver.
  app.delete('/api/campaigns/:id/report/share', async (request, reply) => {
    const campaign = await owned((request.params as { id: string }).id, request.user!.id);
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada.' });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { reportToken: null } });
    return { shareToken: null };
  });

  // PÚBLICO (liberado em auth.ts): só os números, pelo código do link. Código errado, link
  // desativado e campanha excluída respondem igual.
  app.get('/api/public/report/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const campaign = TOKEN.test(token) ? await prisma.campaign.findFirst({ where: { reportToken: token, deletedAt: null }, select: { id: true } }) : null;
    const report = campaign && await buildReport(campaign.id);
    if (!report) return reply.code(404).send({ error: 'Relatório não encontrado ou link desativado.' });
    return reply.header('X-Robots-Tag', 'noindex, nofollow').send(report);
  });
}
