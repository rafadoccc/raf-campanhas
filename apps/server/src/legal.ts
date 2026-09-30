import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma, lockCampaign, LOCKING_TRANSACTION } from '@campaign/database';
import type { AppConfig } from './config';
import { TERMS_VERSION, ServerBusyError, clearSessionCookie, requireSuperAdmin, verifyPassword } from './auth';
import { publicMessage } from './security';

// LGPD (ADR-040): aceite dos Termos, direitos do titular (baixar e excluir os dados) e prazo de
// guarda. O DocDrop é o controlador dos dados da conta e o operador dos dados das campanhas, que
// pertencem ao cliente.

export const PRODUCT_NAME = 'DocDrop';
/** Prazo de guarda do conteúdo das campanhas encerradas (mensagens, mídias, histórico). */
export const RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;
/** Mídia enviada que nunca entrou numa campanha (o formulário foi abandonado) sai depois disto. */
const ORPHAN_MEDIA_MS = DAY_MS;

class AccountError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type WhatsAppControl = {
  /** Logout e remoção da autenticação do usuário (WhatsAppManager.disconnect). */
  disconnect(userId: string): Promise<unknown>;
  /** Pasta da sessão do WhatsApp do usuário (WhatsAppManager.sessionDirFor). */
  sessionDirFor(userId: string): string;
};

/**
 * Apaga a conta e TUDO dela: campanhas (com mensagens, horários, envios e leituras), mídias,
 * grupos, sessões de login, conexão e pasta do WhatsApp. Sem volta.
 */
export async function deleteAccount(userId: string, whatsapp: WhatsAppControl) {
  await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, whatsapp: { select: { accountJid: true } } } });
    if (!user) throw new AccountError('Conta não encontrada.', 404);
    if (user.role === 'SUPER_ADMIN') throw new AccountError('Conta de administrador não pode ser excluída. Passe o papel de administrador para outra conta antes.');
    const campaigns = await tx.campaign.findMany({ where: { userId }, select: { id: true, accountJid: true } });
    // Mesma ordem de travas do despachante (número, depois campanha): sem impasse com um envio.
    const numbers = [...new Set([user.whatsapp?.accountJid, ...campaigns.map(c => c.accountJid)].filter((jid): jid is string => Boolean(jid)))].sort();
    for (const jid of numbers) await tx.$queryRaw`SELECT id FROM \`WhatsAppAccount\` WHERE id = ${jid} FOR UPDATE`;
    for (const { id } of [...campaigns].sort((a, b) => a.id.localeCompare(b.id))) await lockCampaign(tx, id);
    if (await tx.delivery.count({ where: { campaign: { userId }, status: 'PROCESSING' } })) {
      throw new AccountError('Há um envio saindo agora. Tente de novo em um minuto.', 409);
    }
    // Campanhas levam junto (cascata) mensagens, horários, grupos da campanha, envios e leituras.
    await tx.campaign.deleteMany({ where: { userId } });
    await tx.campaignMedia.deleteMany({ where: { userId } });
    await tx.group.deleteMany({ where: { userId } });
    await tx.pendingRead.deleteMany({ where: { ownerId: userId } });
    // Ritmo de envio do número: só se nenhuma outra conta usou o mesmo número.
    for (const jid of numbers) {
      if (!await tx.campaign.count({ where: { accountJid: jid } })) await tx.whatsAppAccount.deleteMany({ where: { id: jid } });
    }
    // Sessões de login e registro da conexão saem em cascata com o usuário.
    await tx.user.delete({ where: { id: userId } });
  }, { ...LOCKING_TRANSACTION, timeout: 30_000 });
  // Depois do banco: se algo acima falhar, a conta e o WhatsApp continuam intactos.
  await whatsapp.disconnect(userId).catch(() => undefined);
  // A pasta do usuário inteira (sessão, trava e formato do @todos). O caminho vem de
  // whatsappSessionDir, que só aceita o id interno e nunca sai da pasta de sessões.
  await rm(path.dirname(whatsapp.sessionDirFor(userId)), { recursive: true, force: true }).catch(() => undefined);
}

/** Tudo o que o sistema guarda da conta, em JSON (direito de acesso e portabilidade). */
export async function exportAccount(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, role: true, createdAt: true, termsAcceptedAt: true, termsVersion: true,
      sessions: { orderBy: { createdAt: 'desc' }, select: { createdAt: true, lastSeenAt: true, expiresAt: true, ip: true, userAgent: true } },
      whatsapp: { select: { accountJid: true, state: true, lastConnectedAt: true } },
    },
  });
  const [groups, media, campaigns] = await Promise.all([
    prisma.group.findMany({ where: { userId }, orderBy: { name: 'asc' }, select: { name: true, externalId: true, active: true, participants: true, isAdmin: true, createdAt: true } }),
    prisma.campaignMedia.findMany({ where: { userId }, select: { id: true, name: true, mimeType: true, kind: true, size: true, createdAt: true } }),
    prisma.campaign.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        name: true, status: true, mode: true, startsAt: true, endsAt: true, intervalSeconds: true, mentionAll: true, createdAt: true, mediaId: true,
        messages: { orderBy: { position: 'asc' }, select: { content: true } },
        schedules: { select: { time: true, timezone: true } },
        groups: { orderBy: { position: 'asc' }, select: { group: { select: { name: true } } } },
        deliveries: {
          orderBy: { sequence: 'asc' },
          select: { status: true, scheduledAt: true, sentAt: true, deliveredAt: true, error: true, group: { select: { name: true } }, _count: { select: { reads: true } } },
        },
      },
    }),
  ]);
  const { sessions, whatsapp, ...account } = user;
  return {
    sistema: PRODUCT_NAME,
    geradoEm: new Date().toISOString(),
    conta: account,
    acessos: sessions,
    whatsapp,
    grupos: groups,
    midias: media,
    campanhas: campaigns.map(({ messages, schedules, groups: linked, deliveries, ...campaign }) => ({
      ...campaign,
      mensagens: messages.map(m => m.content),
      horarios: schedules,
      grupos: linked.map(g => g.group.name),
      envios: deliveries.map(({ group, _count, ...delivery }) => ({ ...delivery, grupo: group.name, leituras: _count.reads })),
    })),
  };
}

/**
 * Prazo de guarda (ADR-040). Apaga de vez:
 * - campanhas excluídas pelo usuário (na tela elas já tinham sumido);
 * - campanhas encerradas ou concluídas sem mudança há mais de RETENTION_DAYS;
 * - mídias que não estão em nenhuma campanha;
 * - grupos que saíram do WhatsApp há mais de RETENTION_DAYS e não estão em nenhuma campanha.
 * `userId` restringe a uma conta (usado nos testes).
 */
export async function purgeExpiredData(now = new Date(), options: { userId?: string; batch?: number } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const owner = options.userId ? { userId: options.userId } : {};
  const expired = { OR: [{ deletedAt: { not: null } }, { status: { in: ['COMPLETED', 'CANCELLED'] as ('COMPLETED' | 'CANCELLED')[] }, updatedAt: { lt: cutoff } }] };
  const candidates = await prisma.campaign.findMany({ where: { ...owner, ...expired }, select: { id: true }, take: options.batch ?? 200 });
  let campaigns = 0;
  for (const { id } of candidates) {
    const removed = await prisma.$transaction(async tx => {
      await lockCampaign(tx, id);
      // Confere de novo sob a trava: pode ter sido reaberta ("tentar de novo") nesse meio tempo.
      const still = await tx.campaign.count({ where: { id, ...expired } });
      if (!still || await tx.delivery.count({ where: { campaignId: id, status: { in: ['PENDING', 'PROCESSING'] } } })) return false;
      await tx.campaign.delete({ where: { id } });
      return true;
    }, LOCKING_TRANSACTION).catch(() => false);
    if (removed) campaigns++;
  }
  const media = await prisma.campaignMedia.deleteMany({ where: { ...owner, campaigns: { none: {} }, createdAt: { lt: new Date(now.getTime() - ORPHAN_MEDIA_MS) } } });
  const groups = await prisma.group.deleteMany({ where: { ...owner, active: false, updatedAt: { lt: cutoff }, campaigns: { none: {} }, deliveries: { none: {} } } });
  return { campaigns, media: media.count, groups: groups.count };
}

/** Roda a limpeza na partida (depois de 2 min) e a cada 6 horas. */
export function startRetentionSweep() {
  const run = () => void purgeExpiredData()
    .then(result => { if (result.campaigns || result.media || result.groups) console.info('[LGPD] Limpeza do prazo de guarda:', JSON.stringify(result)); })
    .catch(error => console.warn('[LGPD] Limpeza do prazo de guarda falhou:', error instanceof Error ? error.message : error));
  const first = setTimeout(run, 2 * 60_000);
  const timer = setInterval(run, 6 * 3_600_000);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

export function registerLegalRoutes(app: FastifyInstance, config: AppConfig, whatsapp: WhatsAppControl) {
  // Público: as páginas de Privacidade e Termos abrem sem login.
  app.get('/api/legal', async () => ({ product: PRODUCT_NAME, contactEmail: config.contactEmail, termsVersion: TERMS_VERSION, retentionDays: RETENTION_DAYS }));

  app.post('/api/account/terms', async request => {
    await prisma.user.update({ where: { id: request.user!.id }, data: { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION } });
    return { user: { ...request.user!, termsPending: false } };
  });

  app.get('/api/account/export', async (request, reply) => {
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Disposition', `attachment; filename="docdrop-meus-dados-${date}.json"`)
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(await exportAccount(request.user!.id), null, 2));
  });

  // Excluir a própria conta: exige a senha, mesmo com a sessão aberta.
  app.post('/api/account/delete', async (request, reply) => {
    const password = (request.body as { password?: unknown } | null)?.password;
    try {
      if (typeof password !== 'string' || !password || password.length > 200) throw new AccountError('Digite a sua senha para confirmar.');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id }, select: { passwordHash: true } });
      if (!await verifyPassword(password, user.passwordHash)) throw new AccountError('Senha incorreta.');
      await deleteAccount(request.user!.id, whatsapp);
      clearSessionCookie(reply, config);
      return { deleted: true };
    } catch (error) {
      if (error instanceof ServerBusyError) return reply.code(503).send({ error: error.message });
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível excluir a conta.') });
    }
  });

  // O administrador atende um pedido de exclusão recebido pelo canal de contato.
  app.delete('/api/admin/users/:id', { preHandler: requireSuperAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      if (id === request.user!.id) throw new AccountError('Você não pode excluir a própria conta por aqui.');
      await deleteAccount(id, whatsapp);
      return { deleted: true };
    } catch (error) {
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível excluir a conta.') });
    }
  });
}
