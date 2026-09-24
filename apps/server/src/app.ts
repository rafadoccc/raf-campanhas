import Fastify, { type FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { prisma, completeFinished, resumeAt, currentTime, TIME_ZONE, clockStatus, lockCampaign, LOCKING_TRANSACTION, MAX_SEND_ATTEMPTS, paceKey, MIN_INTERVAL_SECONDS, effectiveInterval } from '@campaign/database';
import { forecastQueue } from './queue-forecast';
import { registerCampaignRoutes } from './campaign-routes';
import { planDeliveries } from './schedule';
import { registerMediaRoutes } from './media';
import type { WhatsAppProvider } from './whatsapp';
import { loadConfig, type AppConfig } from './config';
import { registerAuth } from './auth';
import { registerSecurity, registerWeb, publicMessage, NotFoundError } from './security';
import { WhatsAppManager } from './whatsapp-manager';
import { createSendingRouter } from './sending-router';
import { registerAdminRoutes } from './admin-routes';
import { usesLegacySession } from './legacy-session';

export type WhatsAppConnection = Pick<WhatsAppProvider, 'status' | 'connect' | 'disconnect' | 'sync' | 'hasPairedSession'>;

export function buildApp(provider: WhatsAppConnection, config: AppConfig = loadConfig({}), manager: WhatsAppManager = new WhatsAppManager()) {
  const app = Fastify({
    trustProxy: config.trustProxy,
    // Cookie de sessão nunca vai para o log.
    logger: { level: process.env.LOG_LEVEL ?? 'warn', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] }
  });
  // Ordem importa: Host/Origem, depois sessão; só então as rotas.
  registerSecurity(app, config);
  registerAuth(app, config);
  // Conexão do WhatsApp SEMPRE pela sessão de quem pediu (ADR-021). Nada do cliente escolhe
  // conexão. A ponte legada só vale para o dono comprovado da sessão global (sai na 4E).
  const legacyBridge = { legacyProvider: provider, ownSessionDir: (userId: string) => manager.sessionDirFor(userId) };
  // Ativar campanha real usa a conexão DO DONO da campanha (ADR-022), nunca "a conexão atual".
  const sending = createSendingRouter<WhatsAppConnection>({ manager, legacyProvider: provider });
  const connectionOf = async (request: FastifyRequest) => {
    const owner = request.user!;
    if (await usesLegacySession(owner, legacyBridge)) return { connection: provider as WhatsAppConnection, legacy: true, owner };
    return { connection: manager.for(owner.id), legacy: false, owner };
  };
  for (const [path, method] of [['status', 'GET'], ['connect', 'POST'], ['disconnect', 'POST'], ['sync', 'POST']] as const) {
    app.route({ method, url: `/api/whatsapp/${path}`, handler: async (request, reply) => {
      try {
        const { connection, legacy, owner } = await connectionOf(request);
        // status: o QR vem só da memória do provider daquele usuário, nunca do banco.
        if (path === 'status') return connection.status();
        if (path === 'connect') {
          const status = await connection.connect();
          if (!legacy) await manager.persistState(owner.id);
          return status;
        }
        if (path === 'disconnect') {
          // Logout explícito: encerra e remove a autenticação SÓ deste usuário.
          return legacy ? await connection.disconnect() : await manager.disconnect(owner.id);
        }
        // Os grupos sincronizados pertencem a quem está logado (dono vem da sessão, ADR-017).
        return await connection.sync(owner.id);
      } catch (error) {
        return reply.code(503).send({ error: publicMessage(error, 'Conector indisponível.') });
      }
    } });
  }

app.get('/api/time', async (_request, reply) => { try { return { now: await currentTime(), timezone: TIME_ZONE, ...clockStatus() }; } catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : 'Horário indisponível.' }); } });

// Confirma que o banco responde: "ok" com o banco fora do ar esconderia a falha real.
app.get('/api/health', async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'ok' };
  } catch {
    return reply.code(503).send({ status: 'error', database: 'unavailable', error: 'Banco de dados indisponível. Verifique o serviço MySQL80.' });
  }
});

// Tudo abaixo é escopado pelo usuário da sessão (ADR-018); nada do cliente define o escopo.
app.get('/api/groups', async request => prisma.group.findMany({ where: { userId: request.user!.id }, orderBy: { name: 'asc' } }));

app.post('/api/groups', async (request, reply) => {
  const body = request.body as { name?: unknown; externalId?: unknown };
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const externalId = undefined; // Only the connector may assign real WhatsApp group identifiers.
  if (!name) return reply.status(400).send({ error: 'O nome do grupo é obrigatório.' });
  if (name.length > 255) return reply.status(400).send({ error: 'O nome do grupo pode ter no máximo 255 caracteres.' });
  // Dono = usuário da sessão; nada do corpo define o dono (ADR-017).
  return reply.status(201).send(await prisma.group.create({ data: { name, externalId: externalId || null, userId: request.user!.id } }));
});

registerMediaRoutes(app);
registerCampaignRoutes(app);
// Painel do SUPER_ADMIN (Fase 6): toda rota passa por requireSuperAdmin.
registerAdminRoutes(app, { manager, legacy: { ...legacyBridge, legacyProvider: provider } });
// Lista paginada por cursor (rolagem infinita, ADR-026): só o que o cartão mostra — nada de
// mensagens, lista de grupos ou mídia inteira.
app.get('/api/campaigns', async request => {
  await completeFinished(prisma);
  const query = request.query as { cursor?: string; limit?: string; status?: string; q?: string };
  const take = Math.min(50, Math.max(1, parseInt(query.limit ?? '24') || 24));
  // Filtros opcionais: situação (uma ou várias, separadas por vírgula) e parte do nome.
  const allowed = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
  const statuses = (typeof query.status === 'string' ? query.status.split(',') : []).filter((x): x is typeof allowed[number] => (allowed as readonly string[]).includes(x));
  const search = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const page = await prisma.campaign.findMany({
    where: { deletedAt: null, userId: request.user!.id, ...(statuses.length ? { status: { in: statuses } } : {}), ...(search ? { name: { contains: search } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(typeof query.cursor === 'string' && query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: {
      id: true, name: true, startsAt: true, endsAt: true, status: true, provider: true, intervalSeconds: true, mode: true, mentionAll: true, createdAt: true,
      schedules: { orderBy: { time: 'asc' }, select: { time: true } },
      media: { select: { id: true, kind: true, color: true } },
      _count: { select: { groups: true } },
    },
  });
  const items = page.slice(0, take);
  // Contagem por status, para o bloco da campanha mostrar o progresso sem abrir o detalhe.
  const counts = await prisma.delivery.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: items.map(c => c.id) } }, _count: { _all: true } });
  return {
    items: items.map(({ _count, ...campaign }) => ({
      ...campaign,
      groupCount: _count.groups,
      progress: Object.fromEntries(counts.filter(row => row.campaignId === campaign.id).map(row => [row.status, row._count._all])),
    })),
    nextCursor: page.length > take ? items[items.length - 1].id : null,
  };
});

app.get('/api/deliveries', async (request) => {
  const query = request.query as { status?: string; campaignId?: string; page?: string };
  const statuses = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'] as const;
  const status = statuses.find(item => item === query.status);
  const page = Math.max(0, Math.min(10000, parseInt(query.page ?? '0') || 0));
  const deliveries = await prisma.delivery.findMany({
    where: { campaign: { userId: request.user!.id }, ...(status ? { status } : {}), ...(query.campaignId ? { campaignId: query.campaignId } : {}) },
    orderBy: query.campaignId ? { sequence: 'asc' } : { scheduledAt: 'desc' },
    take: 100,
    skip: page * 100,
    // Sem messageBody: a listagem não precisa do texto das mensagens e não deve expô-lo.
    select: { id: true, campaignId: true, groupId: true, status: true, provider: true, sequence: true, scheduledAt: true, sentAt: true, error: true, attemptedAt: true, sendReturnedAt: true, deliveredAt: true, serverRejectedAt: true, errorCode: true, attempts: true, sendContext: true, campaign: { select: { name: true } }, group: { select: { name: true, participants: true } }, _count: { select: { reads: true } } }
  });
  // Previsão e motivo de espera dos pendentes (só na 1ª página: as anteriores definem a fila).
  const campaign = query.campaignId && page === 0 && !status ? await prisma.campaign.findFirst({ where: { id: query.campaignId, userId: request.user!.id } }) : null;
  // O número pode estar ocupado por outra campanha (ADR-006): a previsão parte do mais tarde dos dois relógios.
  const accountId = campaign ? paceKey(campaign.provider, campaign.accountJid) : null;
  const account = accountId ? await prisma.whatsAppAccount.findUnique({ where: { id: accountId } }) : null;
  const numberFreeAt = Math.max(account?.nextAvailableAt?.getTime() ?? 0, account?.lastSendEndedAt ? account.lastSendEndedAt.getTime() + effectiveInterval(campaign?.intervalSeconds ?? 0) * 1000 : 0);
  const paced = campaign ? { ...campaign, nextAvailableAt: new Date(Math.max(campaign.nextAvailableAt?.getTime() ?? 0, numberFreeAt)) } : null;
  const forecast = paced ? forecastQueue(deliveries, paced, await currentTime(), provider.status().state === 'connected', MAX_SEND_ATTEMPTS) : null;
  return deliveries.map(delivery => ({ ...delivery, wait: forecast?.get(delivery.id) ?? null }));
});

for (const method of ['POST', 'PATCH'] as const) app.route({ method, url: method === 'POST' ? '/api/campaigns' : '/api/campaigns/:id', handler: async (request, reply) => {
  const body = request.body as { name?: unknown; startsAt?: unknown; endsAt?: unknown; groupIds?: unknown; messages?: unknown; times?: unknown; mode?: unknown; intervalSeconds?: unknown; mediaId?: unknown; mentionAll?: unknown };
  if (body?.mediaId !== undefined && body.mediaId !== null && (typeof body.mediaId !== 'string' || !await prisma.campaignMedia.count({ where: { id: body.mediaId, userId: request.user!.id } }))) return reply.code(400).send({ error: 'Mídia inválida. Selecione um arquivo novamente.' });
  const mediaId = typeof body?.mediaId === 'string' ? body.mediaId : body?.mediaId === null ? null : undefined;
  const mode = body?.mode ?? 'SCHEDULED';
  const intervalSeconds = body?.intervalSeconds ?? 180;
  if (body?.mentionAll !== undefined && typeof body.mentionAll !== 'boolean') return reply.code(400).send({ error: 'Opção "marcar todos" inválida.' });
  const mentionAll = body?.mentionAll === true;
  if (!['IMMEDIATE', 'SCHEDULED'].includes(String(mode)) || typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > 3600) return reply.code(400).send({ error: 'Modo inválido ou intervalo fora de 3 a 60 minutos (mínimo de 3 minutos entre grupos).' });
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const now = await currentTime();
  const startsAt = mode === 'IMMEDIATE' ? now : new Date(String(body?.startsAt ?? ''));
  const endsAt = mode === 'IMMEDIATE' ? startsAt : new Date(String(body?.endsAt ?? ''));
  const groupIds = Array.isArray(body?.groupIds) ? body.groupIds.filter((id): id is string => typeof id === 'string') : [];
  const messages = Array.isArray(body?.messages) ? body.messages.filter((message): message is string => typeof message === 'string' && Boolean(message.trim())).map(message => message.trim()) : [];
  const times = Array.isArray(body?.times) ? body.times.filter((time): time is string => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) : [];
  if (Array.isArray(body?.groupIds) && (groupIds.length !== body.groupIds.length || new Set(groupIds).size !== groupIds.length)) return reply.code(400).send({ error: 'Grupos inválidos ou repetidos.' });
  if (Array.isArray(body?.messages) && messages.length !== body.messages.length) return reply.code(400).send({ error: 'Há mensagens vazias ou inválidas.' });
  if (mode === 'SCHEDULED') {
    const start = String(body.startsAt ?? ''); const end = String(body.endsAt ?? '');
    const today = DateTime.fromJSDate(now, { zone: TIME_ZONE }).toISODate()!;
    if (![start, end].every(s => /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid) || end < today || endsAt.getTime() - startsAt.getTime() > 366 * 86400000 || !Array.isArray(body.times) || times.length !== body.times.length || times.length > 24) return reply.code(400).send({ error: 'Informe datas atuais/futuras (até 366 dias) e horários válidos.' });
  }

  if (!name || name.length > 200 || Number.isNaN(startsAt.valueOf()) || Number.isNaN(endsAt.valueOf()) || endsAt < startsAt || !groupIds.length || groupIds.length > 500 || !messages.length || messages.length > 20 || messages.some(m => m.length > 10000) || (mode === 'SCHEDULED' && !times.length)) {
    return reply.status(400).send({ error: 'Informe nome, período válido, pelo menos um grupo, uma mensagem e um horário.' });
  }
  // Só grupos do próprio usuário (o banco também recusa, pela chave composta de CampaignGroup).
  const groupsFound = await prisma.group.count({ where: { id: { in: groupIds }, active: true, userId: request.user!.id } });
  if (groupsFound !== new Set(groupIds).size) return reply.status(400).send({ error: 'Um ou mais grupos selecionados não existem ou estão inativos.' });

  if (mode === 'SCHEDULED' && !times.some(time => DateTime.fromISO(`${String(body.endsAt)}T${time}`, { zone: 'America/Sao_Paulo' }).toMillis() > now.getTime())) return reply.code(400).send({ error: 'Todos os horários já passaram no fuso de São Paulo. Escolha um horário futuro, outra data ou Fila única.' });

  if (method === 'PATCH') {
    const { id } = request.params as { id: string };
    try {
      const updated = await prisma.$transaction(async tx => {
        await lockCampaign(tx, id);
        const campaign = await tx.campaign.findUnique({ where: { id } });
        if (!campaign || campaign.deletedAt || campaign.userId !== request.user!.id) throw new NotFoundError('Campanha não encontrada.');
        if (campaign.status !== 'DRAFT') throw new Error('Somente rascunhos podem ser editados.');
        return tx.campaign.update({ where: { id }, data: {
          name, startsAt, endsAt, mode: String(mode), intervalSeconds, mentionAll, updatedAt: now, mediaId,
          groups: { deleteMany: {}, create: groupIds.map((groupId, position) => ({ groupId, position })) },
          messages: { deleteMany: {}, create: messages.map((content, position) => ({ content, position })) },
          schedules: { deleteMany: {}, create: mode === 'SCHEDULED' ? [...new Set(times)].map(time => ({ time })) : [] }
        } });
      }, LOCKING_TRANSACTION);
      return reply.send(updated);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível salvar.') });
    }
  }
  return reply.status(201).send(await prisma.campaign.create({
    data: {
      userId: request.user!.id, // dono = sessão; body.userId é ignorado (ADR-017)
      name, startsAt, endsAt, status: 'DRAFT', mode: String(mode), intervalSeconds, mentionAll, createdAt: now, updatedAt: now, mediaId,
      groups: { create: [...new Set(groupIds)].map((groupId, position) => ({ groupId, position })) },
      messages: { create: messages.map((content, position) => ({ content, position })) },
      schedules: { create: mode === 'SCHEDULED' ? [...new Set(times)].map(time => ({ time })) : [] }
    },
    include: { groups: { include: { group: true } }, messages: true, schedules: true }
  }));
} });

app.patch('/api/campaigns/:id/status', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { status?: string; provider?: string; consent?: boolean } | null;
  if (!body || !['ACTIVE', 'PAUSED', 'CANCELLED'].includes(body.status ?? '')) return reply.code(400).send({ error: 'Status inválido.' });
  const next = body.status as 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  try {
    await completeFinished(prisma);
    return await prisma.$transaction(async tx => {
      await lockCampaign(tx, id);
      const campaign = await tx.campaign.findUnique({ where: { id }, include: { groups: { orderBy: { position: 'asc' }, include: { group: true } }, messages: { orderBy: { position: 'asc' } }, schedules: true } });
      if (!campaign || campaign.deletedAt || campaign.userId !== request.user!.id) throw new NotFoundError('Campanha não encontrada.');
      const transitions: Record<string, string[]> = { DRAFT: ['ACTIVE', 'CANCELLED'], ACTIVE: ['PAUSED', 'CANCELLED'], PAUSED: ['ACTIVE', 'CANCELLED'], CANCELLED: [], COMPLETED: [] };
      if (!transitions[campaign.status].includes(next)) throw new Error('Mudança de status não permitida.');
      let campaignProvider = campaign.provider; let accountJid = campaign.accountJid;
      const now = await currentTime(); let nextAvailableAt = campaign.nextAvailableAt;
      if (next === 'ACTIVE') {
        if (campaign.status === 'DRAFT') campaignProvider = body.provider ?? 'simulator';
        if (!['simulator', 'baileys'].includes(campaignProvider)) throw new Error('Provedor inválido.');
        if (campaignProvider === 'baileys') {
          if (body.consent !== true) throw new Error('Confirme a autorização dos grupos para envio real.');
          // O número precisa ser do MESMO usuário dono da campanha.
          const connection = (await sending.forOwner(campaign.userId))?.status();
          if (connection?.state !== 'connected' || !connection.accountJid) throw new Error('Conecte o WhatsApp primeiro.');
          if (accountJid && accountJid !== connection.accountJid) throw new Error('Conecte o mesmo número usado na ativação.');
          accountJid = connection.accountJid;
          if (campaign.groups.some(g => !g.group.active || !g.group.externalId?.endsWith('@g.us'))) throw new Error('Selecione somente grupos sincronizados e ativos do WhatsApp.');
        }
        if (campaign.status === 'DRAFT') {
          const planned = planDeliveries({ ...campaign, provider: campaignProvider }, now);
          if (!planned.length) throw new Error('Os horários já passaram no fuso de São Paulo. Clique em Editar para ajustar datas e horários ou escolher Fila única.');
          await tx.delivery.createMany({ data: planned.map(delivery => ({ ...delivery, createdAt: now, updatedAt: now })) });
          nextAvailableAt = now;
        } else {
          if (!await tx.delivery.count({ where: { campaignId: id, status: { in: ['PENDING', 'PROCESSING'] } } })) throw new Error('Não há envios pendentes. Campanha encerrada.');
          nextAvailableAt = resumeAt(campaign.nextAvailableAt, campaign.pausedAt, now);
        }
      }
      if (next === 'CANCELLED') await tx.delivery.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      return tx.campaign.update({ where: { id }, data: { updatedAt: now, status: next, provider: campaignProvider, accountJid, nextAvailableAt, pausedAt: next === 'PAUSED' ? now : null } });
    }, { ...LOCKING_TRANSACTION, timeout: 30000 });
  } catch (error) {
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    return reply.code(400).send({ error: publicMessage(error, 'Falha ao atualizar.') });
  }
});

  registerWeb(app, config);
  return app;
}
