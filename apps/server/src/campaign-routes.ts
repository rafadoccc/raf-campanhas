import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { dashboardSummary } from './dashboard';
import { publicMessage, NotFoundError } from './security';
import { mediaMetadata } from './media';
import { isUncertainFailure } from './send-context';
import { prisma, completeFinished, lockCampaign, currentTime, TIME_ZONE, campaignReads, LOCKING_TRANSACTION, dueOrRunning } from '@campaign/database';

// Reabre um FAILED para PENDING agora (ADR-030): o piso de 3 min e o relógio do número em
// claimDelivery decidem quando ele realmente sai, então marcar "agora" nunca fura o ritmo.
// Uma campanha COMPLETED volta a ACTIVE para o despachante voltar a olhar para ela.
async function requeueForRetry(tx: Parameters<typeof lockCampaign>[0], campaignId: string, deliveryIds: string[], campaignStatus: string, now: Date) {
  await tx.delivery.updateMany({ where: { id: { in: deliveryIds } }, data: { status: 'PENDING', scheduledAt: now, error: null, errorCode: null, serverRejectedAt: null, sendReturnedAt: null, updatedAt: now } });
  if (campaignStatus === 'COMPLETED') await tx.campaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', pausedAt: null, updatedAt: now } });
}

export function registerCampaignRoutes(app: FastifyInstance) {
  app.get('/api/campaigns/:id', async (request, reply) => {
    await completeFinished(prisma);
    const { id } = request.params as { id: string };
    // Só campanha própria; de outro usuário responde igual a inexistente (ADR-018).
    const campaign = await prisma.campaign.findFirst({ where: { id, deletedAt: null, userId: request.user!.id }, include: { media: { select: mediaMetadata }, groups: { orderBy: { position: 'asc' }, include: { group: true } }, messages: { orderBy: { position: 'asc' } }, schedules: true } });
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada.' });
    const counts = await prisma.delivery.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } });
    // Próximo a sair: a cabeça já vencida; senão, o pendente de horário mais cedo (ADR-014).
    const now = await currentTime();
    const next = await prisma.delivery.findFirst({ where: { campaignId: id, ...dueOrRunning(now) }, orderBy: { sequence: 'asc' } })
      ?? await prisma.delivery.findFirst({ where: { campaignId: id, status: 'PENDING' }, orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }] });
    const nextAt = next && campaign.status === 'ACTIVE' ? new Date(Math.max(next.scheduledAt.getTime(), campaign.nextAvailableAt?.getTime() ?? 0)) : null;
    const delivered = await prisma.delivery.count({ where: { campaignId: id, status: 'SENT', deliveredAt: { not: null } } });
    const reads = await campaignReads(prisma, id);
    const readsByGroup = campaign.groups.map(({ group }) => ({ groupId: group.id, name: group.name, participants: group.participants, count: reads.find(r => r.groupId === group.id)?.count ?? 0 }));
    const serverNow = await currentTime();
    return { ...campaign, serverNow, delivered, readsTotal: reads.reduce((sum, r) => sum + r.count, 0), readsByGroup, progress: Object.fromEntries(counts.map(r => [r.status, r._count._all])), nextAt };
  });
  app.delete('/api/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return await prisma.$transaction(async tx => {
      await lockCampaign(tx, id);
      const campaign = await tx.campaign.findUnique({ where: { id } });
      if (!campaign || campaign.userId !== request.user!.id) throw new NotFoundError('Campanha não encontrada.');
      if (campaign.deletedAt) return { deleted: true };
      if (!['DRAFT', 'CANCELLED', 'COMPLETED'].includes(campaign.status)) throw new Error('Encerre antes de excluir.');
      if (await tx.delivery.count({ where: { campaignId: id, status: 'PROCESSING' } })) throw new Error('Aguarde o envio em andamento.');
      await tx.delivery.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED', error: 'Campanha excluída.' } });
      await tx.campaign.update({ where: { id }, data: { deletedAt: await currentTime(), status: campaign.status === 'DRAFT' ? 'CANCELLED' : campaign.status } });
      return { deleted: true };
    }, LOCKING_TRANSACTION); } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Falha ao excluir.') });
    }
  });
  app.get('/api/dashboard', async request => dashboardSummary(request.user!.id));

  // "Usar de novo" (ADR-026): nova campanha em RASCUNHO com os mesmos grupos, mensagens, mídia,
  // intervalo e horários. A original fica intacta, com o histórico e as métricas dela.
  // Com { reschedule: true } numa campanha ativa ou pausada, encerra os envios pendentes dela na
  // MESMA transação — é o "trocar o horário" sem risco de as duas rodadas enviarem juntas.
  app.post('/api/campaigns/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const reschedule = (request.body as { reschedule?: unknown } | null)?.reschedule === true;
    const userId = request.user!.id;
    try {
      const copy = await prisma.$transaction(async tx => {
        await lockCampaign(tx, id);
        const source = await tx.campaign.findFirst({
          where: { id, userId, deletedAt: null },
          include: { groups: { orderBy: { position: 'asc' }, include: { group: { select: { active: true } } } }, messages: { orderBy: { position: 'asc' } }, schedules: true },
        });
        if (!source) throw new NotFoundError('Campanha não encontrada.');
        if (reschedule) {
          if (!['ACTIVE', 'PAUSED'].includes(source.status)) throw new Error('Só campanhas ativas ou pausadas podem ser reagendadas.');
          const now = await currentTime();
          await tx.delivery.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
          await tx.campaign.update({ where: { id }, data: { status: 'CANCELLED', pausedAt: null, updatedAt: now } });
        }
        const groups = source.groups.filter(g => g.group.active);
        if (!groups.length) throw new Error('Nenhum grupo desta campanha está ativo. Sincronize os grupos.');
        const now = await currentTime();
        // Datas que já passaram viram "a partir de hoje", mantendo a duração do período.
        const today = new Date(`${DateTime.fromJSDate(now, { zone: TIME_ZONE }).toISODate()}T00:00:00.000Z`);
        const span = source.endsAt.getTime() - source.startsAt.getTime();
        const expired = source.endsAt < today;
        const base = source.name.replace(/ \(\d+\)$/, '');
        const siblings = await tx.campaign.count({ where: { userId, name: { startsWith: base } } });
        return tx.campaign.create({ data: {
          userId, name: `${base} (${siblings + 1})`.slice(0, 200), status: 'DRAFT', mode: source.mode, intervalSeconds: source.intervalSeconds, mentionAll: source.mentionAll, mediaId: source.mediaId,
          startsAt: expired ? today : source.startsAt, endsAt: expired ? new Date(today.getTime() + Math.max(0, span)) : source.endsAt,
          createdAt: now, updatedAt: now,
          groups: { create: groups.map((g, position) => ({ groupId: g.groupId, position })) },
          messages: { create: source.messages.map(m => ({ content: m.content, position: m.position })) },
          schedules: { create: source.schedules.map(s => ({ time: s.time, timezone: s.timezone })) },
        }, select: { id: true, name: true } });
      }, LOCKING_TRANSACTION);
      return reply.code(201).send(copy);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível usar de novo.') });
    }
  });

  // Tentar de novo um envio com falha (ADR-030). Falha "incerta" (pode ter chegado) exige
  // { confirmUncertain: true } explícito — sem isso volta 409 para o cliente perguntar antes.
  app.post('/api/deliveries/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const confirmUncertain = (request.body as { confirmUncertain?: unknown } | null)?.confirmUncertain === true;
    const userId = request.user!.id;
    try {
      const outcome = await prisma.$transaction(async tx => {
        const delivery = await tx.delivery.findUnique({ where: { id }, include: { campaign: true } });
        if (!delivery || delivery.campaign.userId !== userId || delivery.campaign.deletedAt) throw new NotFoundError('Envio não encontrado.');
        if (delivery.status !== 'FAILED') throw new Error('Só envios com falha podem ser tentados de novo.');
        if (delivery.campaign.status === 'CANCELLED') throw new Error('Campanha encerrada: use "usar de novo" para reenviar.');
        const uncertain = isUncertainFailure(delivery.error);
        if (uncertain && !confirmUncertain) return { uncertain: true as const };
        await lockCampaign(tx, delivery.campaignId);
        const now = await currentTime();
        await requeueForRetry(tx, delivery.campaignId, [id], delivery.campaign.status, now);
        return { retried: true as const };
      }, LOCKING_TRANSACTION);
      if ('uncertain' in outcome) return reply.code(409).send({ error: 'Resultado incerto: a mensagem pode ter chegado. Confirme para tentar de novo mesmo assim.', uncertain: true });
      return outcome;
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível tentar de novo.') });
    }
  });

  // Tenta de novo todas as falhas SEGURAS (certas) de uma campanha de uma vez; falhas incertas
  // nunca entram no lote (cada uma exige confirmação própria em /deliveries/:id/retry).
  app.post('/api/campaigns/:id/retry-failed', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    try {
      const result = await prisma.$transaction(async tx => {
        await lockCampaign(tx, id);
        const campaign = await tx.campaign.findFirst({ where: { id, userId, deletedAt: null } });
        if (!campaign) throw new NotFoundError('Campanha não encontrada.');
        if (campaign.status === 'CANCELLED') throw new Error('Campanha encerrada: use "usar de novo" para reenviar.');
        const failed = await tx.delivery.findMany({ where: { campaignId: id, status: 'FAILED' }, select: { id: true, error: true } });
        const safe = failed.filter(d => !isUncertainFailure(d.error));
        if (safe.length) await requeueForRetry(tx, id, safe.map(d => d.id), campaign.status, await currentTime());
        return { retried: safe.length, uncertainSkipped: failed.length - safe.length };
      }, LOCKING_TRANSACTION);
      return result;
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível tentar de novo os envios com falha.') });
    }
  });
}
