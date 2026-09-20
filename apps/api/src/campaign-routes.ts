import type { FastifyInstance } from 'fastify';
import { dashboardSummary } from './dashboard';
import { mediaMetadata } from './media';
import { prisma, completeFinished, lockCampaign, currentTime, TIME_ZONE, campaignReads } from '@campaign/database';

export function registerCampaignRoutes(app: FastifyInstance) {
  app.get('/campaigns/:id', async (request, reply) => {
    await completeFinished(prisma);
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findFirst({ where: { id, deletedAt: null }, include: { media: { select: mediaMetadata }, groups: { orderBy: { position: 'asc' }, include: { group: true } }, messages: { orderBy: { position: 'asc' } }, schedules: true } });
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada.' });
    const counts = await prisma.delivery.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } });
    const next = await prisma.delivery.findFirst({ where: { campaignId: id, status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { sequence: 'asc' } });
    const nextAt = next && campaign.status === 'ACTIVE' ? new Date(Math.max(next.scheduledAt.getTime(), campaign.nextAvailableAt?.getTime() ?? 0)) : null;
    const reads = await campaignReads(prisma, id);
    const readsByGroup = campaign.groups.map(({ group }) => ({ groupId: group.id, name: group.name, count: reads.find(r => r.groupId === group.id)?.count ?? 0 }));
    const serverNow = await currentTime();
    return { ...campaign, serverNow, readsTotal: reads.reduce((sum, r) => sum + r.count, 0), readsByGroup, progress: Object.fromEntries(counts.map(r => [r.status, r._count._all])), nextAt };
  });
  app.delete('/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return await prisma.$transaction(async tx => {
      await lockCampaign(tx, id);
      const campaign = await tx.campaign.findUnique({ where: { id } });
      if (!campaign) throw new Error('Campanha não encontrada.');
      if (campaign.deletedAt) return { deleted: true };
      if (!['DRAFT', 'CANCELLED', 'COMPLETED'].includes(campaign.status)) throw new Error('Encerre antes de excluir.');
      if (await tx.delivery.count({ where: { campaignId: id, status: 'PROCESSING' } })) throw new Error('Aguarde o envio em andamento.');
      await tx.delivery.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED', error: 'Campanha excluída.' } });
      await tx.campaign.update({ where: { id }, data: { deletedAt: await currentTime(), status: campaign.status === 'DRAFT' ? 'CANCELLED' : campaign.status } });
      return { deleted: true };
    }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Falha ao excluir.' }); }
  });
  app.get('/dashboard', async () => dashboardSummary());
}
