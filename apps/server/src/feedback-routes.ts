import type { FastifyInstance } from 'fastify';
import { prisma, LOCKING_TRANSACTION } from '@campaign/database';
import { requireSuperAdmin } from './auth';

// Sugestões, críticas, problemas e elogios (ADR-045). Qualquer usuário envia e acompanha os
// próprios; o administrador vê todos, muda a situação e pode responder. Nada do cliente escolhe de
// quem é o envio: o dono vem sempre da sessão.

export const FEEDBACK_KINDS = ['sugestao', 'problema', 'critica', 'elogio'] as const;
export const FEEDBACK_STATUSES = ['novo', 'analisando', 'feito', 'recusado'] as const;
export const FEEDBACK_MAX_LENGTH = 2000;
const FEEDBACK_MIN_LENGTH = 10;
/** Limite suave contra abuso: envios por conta numa hora. */
export const FEEDBACK_PER_HOUR = 5;

type Kind = typeof FEEDBACK_KINDS[number];
type Status = typeof FEEDBACK_STATUSES[number];
const own = { id: true, kind: true, message: true, status: true, reply: true, repliedAt: true, createdAt: true } as const;

export function registerFeedbackRoutes(app: FastifyInstance) {
  app.post('/api/feedback', async (request, reply) => {
    const body = request.body as { kind?: unknown; message?: unknown } | null;
    const kind = FEEDBACK_KINDS.find(k => k === body?.kind);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!kind) return reply.code(400).send({ error: 'Escolha o tipo: sugestão, problema, crítica ou elogio.' });
    if (message.length < FEEDBACK_MIN_LENGTH) return reply.code(400).send({ error: 'Conte um pouco mais (pelo menos 10 caracteres).' });
    if (message.length > FEEDBACK_MAX_LENGTH) return reply.code(400).send({ error: `O texto pode ter no máximo ${FEEDBACK_MAX_LENGTH} caracteres.` });
    const userId = request.user!.id;
    const feedback = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
      const recent = await tx.feedback.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
      if (recent >= FEEDBACK_PER_HOUR) return null;
      return tx.feedback.create({ data: { userId, kind, message }, select: own });
    }, LOCKING_TRANSACTION);
    if (!feedback) return reply.code(429).send({ error: 'Você já enviou várias mensagens na última hora. Tente de novo mais tarde.' });
    return reply.code(201).send(feedback);
  });

  // Só os envios de quem está logado, mais novos primeiro.
  app.get('/api/feedback', async request => prisma.feedback.findMany({ where: { userId: request.user!.id }, orderBy: { createdAt: 'desc' }, take: 100, select: own }));

  const guard = { preHandler: requireSuperAdmin };

  app.get('/api/admin/feedback', guard, async request => {
    const status = FEEDBACK_STATUSES.find(s => s === (request.query as { status?: unknown }).status);
    const [items, counts] = await Promise.all([
      prisma.feedback.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200, select: { ...own, user: { select: { name: true, email: true } } } }),
      prisma.feedback.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return { items, counts: Object.fromEntries(counts.map(row => [row.status, row._count._all])) };
  });

  app.patch('/api/admin/feedback/:id', guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: unknown; reply?: unknown } | null;
    const data: { status?: Status; reply?: string | null; repliedAt?: Date | null } = {};
    if (body?.status !== undefined) {
      const status = FEEDBACK_STATUSES.find(s => s === body.status);
      if (!status) return reply.code(400).send({ error: 'Situação inválida.' });
      data.status = status;
    }
    if (body?.reply !== undefined) {
      if (body.reply !== null && typeof body.reply !== 'string') return reply.code(400).send({ error: 'Resposta inválida.' });
      const text = typeof body.reply === 'string' ? body.reply.trim() : '';
      if (text.length > FEEDBACK_MAX_LENGTH) return reply.code(400).send({ error: `A resposta pode ter no máximo ${FEEDBACK_MAX_LENGTH} caracteres.` });
      data.reply = text || null;
      data.repliedAt = text ? new Date() : null;
    }
    if (!Object.keys(data).length) return reply.code(400).send({ error: 'Nada a alterar.' });
    const { count } = await prisma.feedback.updateMany({ where: { id }, data });
    if (!count) return reply.code(404).send({ error: 'Mensagem não encontrada.' });
    return prisma.feedback.findUnique({ where: { id }, select: { ...own, user: { select: { name: true, email: true } } } });
  });
}

export type { Kind as FeedbackKind, Status as FeedbackStatus };
