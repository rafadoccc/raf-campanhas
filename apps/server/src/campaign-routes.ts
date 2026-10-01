import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { dashboardSummary } from './dashboard';
import { publicMessage, NotFoundError } from './security';
import { mediaMetadata } from './media';
import { isUncertainFailure } from './send-context';
import { prisma, completeFinished, lockCampaign, currentTime, TIME_ZONE, campaignReads, LOCKING_TRANSACTION, dueOrRunning } from '@campaign/database';
import { assertCanSend } from './plans';

// Reabre somente entregas ainda FAILED. O horário original já venceu quando o envio falhou;
// mantê-lo preserva a chave única (campanha + grupo + horário) entre rodadas do mesmo grupo.
// Uma campanha COMPLETED volta a ACTIVE para o despachante voltar a olhar para ela.
async function requeueForRetry(tx: Parameters<typeof lockCampaign>[0], campaignId: string, deliveryIds: string[], campaignStatus: string, now: Date) {
  const updated = await tx.delivery.updateMany({
    where: { id: { in: deliveryIds }, campaignId, status: 'FAILED' },
    data: { status: 'PENDING', error: null, errorCode: null, serverRejectedAt: null, sendReturnedAt: null, updatedAt: now },
  });
  if (updated.count !== deliveryIds.length) throw new Error('O estado dos envios mudou. Atualize a página e tente novamente.');
  if (campaignStatus === 'COMPLETED') await tx.campaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', pausedAt: null, updatedAt: now } });
}

/** Teto de modelos por conta: é uma biblioteca pessoal, não um arquivo. */
export const MAX_TEMPLATES = 50;

export function registerCampaignRoutes(app: FastifyInstance) {
  app.get('/api/campaigns/:id', async (request, reply) => {
    await completeFinished(prisma);
    const { id } = request.params as { id: string };
    // Só campanha própria; de outro usuário responde igual a inexistente (ADR-018).
    const campaign = await prisma.campaign.findFirst({ where: { id, deletedAt: null, userId: request.user!.id }, include: { media: { select: mediaMetadata }, groups: { orderBy: { position: 'asc' }, include: { group: true } }, messages: { orderBy: { position: 'asc' } }, schedules: true } });
    if (!campaign) return reply.code(404).send({ error: 'Campanha não encontrada.' });
    const now = await currentTime();
    // Consultas independentes em paralelo: a tela abre no tempo da mais lenta, não da soma.
    const [counts, due, earliest, delivered, reads] = await Promise.all([
      prisma.delivery.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
      // Próximo a sair: a cabeça já vencida; senão, o pendente de horário mais cedo (ADR-014).
      prisma.delivery.findFirst({ where: { campaignId: id, ...dueOrRunning(now) }, orderBy: { sequence: 'asc' }, select: { scheduledAt: true } }),
      prisma.delivery.findFirst({ where: { campaignId: id, status: 'PENDING' }, orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }], select: { scheduledAt: true } }),
      prisma.delivery.count({ where: { campaignId: id, status: 'SENT', deliveredAt: { not: null } } }),
      campaignReads(prisma, id),
    ]);
    const next = due ?? earliest;
    const nextAt = next && campaign.status === 'ACTIVE' ? new Date(Math.max(next.scheduledAt.getTime(), campaign.nextAvailableAt?.getTime() ?? 0)) : null;
    const readsByGroup = campaign.groups.map(({ group }) => ({ groupId: group.id, name: group.name, participants: group.participants, count: reads.find(r => r.groupId === group.id)?.count ?? 0 }));
    const serverNow = now;
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

  // Modelos de campanha (ADR-047): só o que o cartão mostra. Editar e excluir usam as rotas da
  // própria campanha (um modelo é uma campanha em rascunho marcada com isTemplate).
  app.get('/api/templates', async request => {
    const templates = await prisma.campaign.findMany({
      where: { userId: request.user!.id, isTemplate: true, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: MAX_TEMPLATES,
      select: {
        id: true, name: true, mode: true, mentionAll: true, updatedAt: true,
        schedules: { orderBy: { time: 'asc' }, select: { time: true } },
        media: { select: { id: true, kind: true, color: true } },
        messages: { orderBy: { position: 'asc' }, take: 1, select: { content: true } },
        _count: { select: { groups: true } },
      },
    });
    return templates.map(({ _count, messages, ...template }) => ({ ...template, groupCount: _count.groups, preview: messages[0]?.content.slice(0, 160) ?? '' }));
  });

  // "Usar de novo" (ADR-026): nova campanha em RASCUNHO com os mesmos grupos, mensagens, mídia,
  // intervalo e horários. A original fica intacta, com o histórico e as métricas dela.
  // Com { reschedule: true } numa campanha ativa ou pausada, encerra os envios pendentes dela na
  // MESMA transação — é o "trocar o horário" sem risco de as duas rodadas enviarem juntas.
  //
  // Modelos (ADR-047) usam a mesma cópia: { asTemplate: true } guarda a campanha como modelo;
  // duplicar um modelo (sem asTemplate) cria a campanha em rascunho a partir dele.
  app.post('/api/campaigns/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { reschedule?: unknown; asTemplate?: unknown } | null;
    const reschedule = body?.reschedule === true;
    const asTemplate = body?.asTemplate === true;
    const userId = request.user!.id;
    try {
      const copy = await prisma.$transaction(async tx => {
        await lockCampaign(tx, id);
        const source = await tx.campaign.findFirst({
          where: { id, userId, deletedAt: null },
          include: { groups: { orderBy: { position: 'asc' }, include: { group: { select: { active: true } } } }, messages: { orderBy: { position: 'asc' } }, schedules: true },
        });
        if (!source) throw new NotFoundError('Campanha não encontrada.');
        if (reschedule && (asTemplate || source.isTemplate)) throw new Error('Reagendar não se aplica a modelos.');
        if (asTemplate && await tx.campaign.count({ where: { userId, isTemplate: true, deletedAt: null } }) >= MAX_TEMPLATES) {
          throw new Error(`Você já tem ${MAX_TEMPLATES} modelos. Exclua um para salvar outro.`);
        }
        if (reschedule) {
          if (!['ACTIVE', 'PAUSED'].includes(source.status)) throw new Error('Só campanhas ativas ou pausadas podem ser reagendadas.');
          const now = await currentTime();
          await tx.delivery.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
          await tx.campaign.update({ where: { id }, data: { status: 'CANCELLED', pausedAt: null, updatedAt: now } });
        }
        const groups = source.groups.filter(g => g.group.active);
        if (!groups.length) throw new Error('Nenhum grupo desta campanha está ativo. Sincronize os grupos.');
        const now = await currentTime();
        // Datas que já passaram viram "a partir de hoje", mantendo a duração do período. As de um
        // modelo sempre: elas são só as da campanha de onde ele saiu, não um agendamento.
        const today = new Date(`${DateTime.fromJSDate(now, { zone: TIME_ZONE }).toISODate()}T00:00:00.000Z`);
        const span = source.endsAt.getTime() - source.startsAt.getTime();
        const expired = source.endsAt < today || (source.isTemplate && !asTemplate);
        const base = source.name.replace(/ \(\d+\)$/, '');
        // Campanhas e modelos numeram em separado: o modelo "Sexta" gera a campanha "Sexta", e só
        // a segunda vira "Sexta (2)". "Usar de novo" entre campanhas continua numerando sempre.
        const siblings = await tx.campaign.count({ where: { userId, isTemplate: asTemplate, name: { startsWith: base }, ...(asTemplate ? { deletedAt: null } : {}) } });
        const plain = asTemplate || source.isTemplate;
        const name = plain && !siblings ? base : `${base} (${siblings + 1})`;
        return tx.campaign.create({ data: {
          userId, name: name.slice(0, 200), isTemplate: asTemplate, status: 'DRAFT', mode: source.mode, intervalSeconds: source.intervalSeconds, mentionAll: source.mentionAll, mediaId: source.mediaId,
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
      // Tentar de novo reabre a campanha: conta vencida ou pausada não envia (ADR-050).
      await assertCanSend(userId, await currentTime());
      const outcome = await prisma.$transaction(async tx => {
        // A primeira leitura só identifica qual campanha travar. Estado e autorização são
        // revalidados depois do lock, inclusive se outro retry ou encerramento ganhou a disputa.
        const target = await tx.delivery.findUnique({ where: { id }, select: { campaignId: true } });
        if (!target) throw new NotFoundError('Envio não encontrado.');
        await lockCampaign(tx, target.campaignId);
        const delivery = await tx.delivery.findUnique({ where: { id }, include: { campaign: true } });
        if (!delivery || delivery.campaign.userId !== userId || delivery.campaign.deletedAt) throw new NotFoundError('Envio não encontrado.');
        if (delivery.status !== 'FAILED') throw new Error('Só envios com falha podem ser tentados de novo.');
        if (delivery.campaign.status === 'CANCELLED') throw new Error('Campanha encerrada: use "usar de novo" para reenviar.');
        const uncertain = isUncertainFailure(delivery.error);
        if (uncertain && !confirmUncertain) return { uncertain: true as const };
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
      await assertCanSend(userId, await currentTime());
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
