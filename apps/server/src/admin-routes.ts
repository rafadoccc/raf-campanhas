import type { FastifyInstance } from 'fastify';
import { prisma, currentTime } from '@campaign/database';
import { hashPassword, normalizeEmail, requireSuperAdmin, validateNewPassword, type Role } from './auth';
import { publicMessage } from './security';
import type { WhatsAppManager } from './whatsapp-manager';
import { legacySessionOwnerId, type LegacyBridgeDeps } from './legacy-session';

// Painel do SUPER_ADMIN (ADR-027, Fase 6). Visão OPERACIONAL das contas: status, número
// conectado e contagens. Nunca o conteúdo das campanhas ou mensagens, nunca QR nem senha.
// Toda rota exige requireSuperAdmin (papel lido do banco pela sessão, a cada pedido).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: Role[] = ['SUPER_ADMIN', 'USER'];
const publicUser = { id: true, email: true, name: true, role: true, disabledAt: true, createdAt: true } as const;

class AdminError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Deps = {
  manager: Pick<WhatsAppManager, 'peek' | 'stop'>;
  /** Para mostrar o status da sessão global legada do dono dela (até a migração). */
  legacy: LegacyBridgeDeps & { legacyProvider: { status(): { state: string; accountJid?: string; error?: string } } };
};

export function registerAdminRoutes(app: FastifyInstance, { manager, legacy }: Deps) {
  const guard = { preHandler: requireSuperAdmin };

  app.get('/api/admin/users', guard, async () => {
    const [users, active, results, legacyOwner] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          ...publicUser,
          whatsapp: { select: { state: true, accountJid: true, lastConnectedAt: true, lastError: true } },
          sessions: { orderBy: { lastSeenAt: 'desc' }, take: 1, select: { lastSeenAt: true } },
          _count: { select: { campaigns: { where: { deletedAt: null } }, groups: { where: { active: true } } } },
        },
      }),
      prisma.campaign.groupBy({ by: ['userId'], where: { status: 'ACTIVE', deletedAt: null }, _count: { _all: true } }),
      prisma.$queryRaw<{ userId: string; status: string; n: bigint }[]>`
        SELECT c.userId AS userId, d.status AS status, COUNT(*) AS n
        FROM \`Delivery\` d JOIN \`Campaign\` c ON c.id = d.campaignId
        WHERE d.provider = 'baileys' AND d.status IN ('SENT', 'FAILED')
        GROUP BY c.userId, d.status`,
      legacySessionOwnerId(legacy).catch(() => null),
    ]);
    return users.map(({ sessions, _count, whatsapp, ...user }) => {
      // Estado ao vivo quando a conexão está em memória; senão, o último registrado. Sem QR.
      const live = user.id === legacyOwner ? legacy.legacyProvider.status() : manager.peek(user.id)?.status();
      const count = (status: string) => Number(results.find(r => r.userId === user.id && r.status === status)?.n ?? 0);
      return {
        ...user,
        lastSeenAt: sessions[0]?.lastSeenAt ?? null,
        whatsapp: {
          state: live?.state ?? whatsapp?.state ?? 'disconnected',
          accountJid: live?.accountJid ?? whatsapp?.accountJid ?? null,
          lastConnectedAt: whatsapp?.lastConnectedAt ?? null,
          lastError: live?.error ?? whatsapp?.lastError ?? null,
          legacySession: user.id === legacyOwner,
        },
        counts: {
          campaigns: _count.campaigns,
          activeCampaigns: active.find(a => a.userId === user.id)?._count._all ?? 0,
          groups: _count.groups,
          sent: count('SENT'),
          failed: count('FAILED'),
        },
      };
    });
  });

  app.post('/api/admin/users', guard, async (request, reply) => {
    const body = request.body as { email?: unknown; name?: unknown; password?: unknown; role?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const role = (body?.role ?? 'USER') as Role;
    if (!EMAIL.test(email) || email.length > 191) return reply.code(400).send({ error: 'Informe um e-mail válido.' });
    if (!name || name.length > 120) return reply.code(400).send({ error: 'Informe o nome (até 120 caracteres).' });
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'Papel inválido.' });
    const problem = validateNewPassword(body?.password);
    if (problem) return reply.code(400).send({ error: problem });
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return reply.code(409).send({ error: 'Já existe uma conta com este e-mail.' });
    const user = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(body!.password as string) }, select: publicUser });
    return reply.code(201).send(user);
  });

  // Ativar/desativar e trocar papel. Desativar: derruba as sessões web, pausa as campanhas
  // ativas e encerra a conexão do WhatsApp PRESERVANDO a autenticação (reativar volta a usar).
  app.patch('/api/admin/users/:id', guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { disabled?: unknown; role?: unknown } | null;
    const disabled = typeof body?.disabled === 'boolean' ? body.disabled : undefined;
    const role = body?.role === undefined ? undefined : body.role as Role;
    try {
      if (disabled === undefined && role === undefined) throw new AdminError('Nada a alterar.');
      if (role !== undefined && !ROLES.includes(role)) throw new AdminError('Papel inválido.');
      if (id === request.user!.id) throw new AdminError('Você não pode desativar nem trocar o papel da própria conta.');
      const result = await prisma.$transaction(async tx => {
        const target = await tx.user.findUnique({ where: { id }, select: { id: true, role: true, disabledAt: true } });
        if (!target) throw new AdminError('Usuário não encontrado.', 404);
        const losesAdmin = target.role === 'SUPER_ADMIN' && !target.disabledAt && (disabled === true || role === 'USER');
        if (losesAdmin && await tx.user.count({ where: { role: 'SUPER_ADMIN', disabledAt: null } }) <= 1) {
          throw new AdminError('Não é possível remover o último administrador ativo.');
        }
        const now = await currentTime();
        if (disabled === true) {
          await tx.authSession.deleteMany({ where: { userId: id } });
          await tx.campaign.updateMany({ where: { userId: id, status: 'ACTIVE', deletedAt: null }, data: { status: 'PAUSED', pausedAt: now, updatedAt: now } });
        }
        return tx.user.update({
          where: { id },
          data: { ...(disabled === undefined ? {} : { disabledAt: disabled ? (target.disabledAt ?? now) : null }), ...(role ? { role } : {}) },
          select: publicUser,
        });
      });
      if (disabled === true) await manager.stop(id).catch(() => undefined);
      return result;
    } catch (error) {
      if (error instanceof AdminError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: publicMessage(error, 'Não foi possível atualizar o usuário.') });
    }
  });

  // Nova senha definida pelo administrador: derruba todas as sessões daquela conta.
  app.post('/api/admin/users/:id/password', guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user!.id) return reply.code(400).send({ error: 'Troque a sua senha em Minha conta.' });
    const password = (request.body as { password?: unknown } | null)?.password;
    const problem = validateNewPassword(password);
    if (problem) return reply.code(400).send({ error: problem });
    const updated = await prisma.user.updateMany({ where: { id }, data: { passwordHash: await hashPassword(password as string) } });
    if (!updated.count) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    await prisma.authSession.deleteMany({ where: { userId: id } });
    return { ok: true };
  });
}
