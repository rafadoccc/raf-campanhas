import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { prisma, currentTime, lockCampaign, LOCKING_TRANSACTION, TIME_ZONE } from '@campaign/database';
import { requireSuperAdmin } from './auth';

// Plano da conta (ADR-050). O administrador define, por conta: nome do plano, valor combinado,
// vencimento, pausa e quantos grupos cabem numa campanha. A cobrança acontece fora do sistema
// (Pix, link de pagamento); aqui fica só o resultado dela.
//
// Conta vencida ou pausada continua ENTRANDO e vendo tudo: o que ela não faz é enviar. As
// campanhas ativas são pausadas (do mesmo jeito do botão Pausar) e não podem ser iniciadas nem
// retomadas até o administrador renovar. Administrador não tem plano: nunca é bloqueado.

export type PlanState = 'active' | 'paused' | 'expired';
export const PLAN_LIMITS = { maxGroups: { min: 1, max: 500 }, priceCents: { max: 10_000_000 }, plan: { max: 40 } } as const;
/** Faltando este tanto de dias (ou menos), o painel avisa o cliente do vencimento. */
export const DUE_SOON_DAYS = 5;

type Row = { plan: string | null; priceCents: number | null; dueDate: Date | null; pausedAt: Date | null; maxGroups: number | null };

/** Dia de hoje no calendário de São Paulo, "AAAA-MM-DD" (o vencimento é uma data, não um instante). */
export const todayOf = (now: Date) => DateTime.fromJSDate(now, { zone: TIME_ZONE }).toISODate()!;
const isoDate = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Situação do plano hoje. Pausa ganha de vencimento: é o que o administrador escolheu por último. */
export function planState(row: Pick<Row, 'dueDate' | 'pausedAt'> | null, today: string): PlanState {
  if (row?.pausedAt) return 'paused';
  const due = isoDate(row?.dueDate ?? null);
  return due && today > due ? 'expired' : 'active';
}

const BLOCK = {
  paused: () => 'Sua conta está pausada: os envios ficam parados. Fale com o administrador para reativar.',
  expired: (due: string) => `Sua assinatura venceu em ${brDate(due)}: os envios ficam parados. Fale com o administrador para renovar.`,
};

/** O plano como a conta enxerga (sem o valor, que é controle do administrador). */
export async function planOf(userId: string, now: Date) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, subscription: true } });
  const row = user?.role === 'SUPER_ADMIN' ? null : user?.subscription ?? null;
  const today = todayOf(now);
  const state = planState(row, today);
  const dueDate = isoDate(row?.dueDate ?? null);
  const daysLeft = dueDate ? Math.round((Date.parse(dueDate) - Date.parse(today)) / 86_400_000) : null;
  const blocked = state === 'paused' ? BLOCK.paused() : state === 'expired' ? BLOCK.expired(dueDate!) : null;
  return { plan: row?.plan ?? null, dueDate, daysLeft, state, maxGroups: row?.maxGroups ?? null, blocked };
}

/** Recusa (com a mensagem para a tela) se a conta não pode enviar agora. */
export async function assertCanSend(userId: string, now: Date) {
  const { blocked } = await planOf(userId, now);
  if (blocked) throw new Error(blocked);
}

/** Recusa se a campanha tem mais grupos do que o plano permite. */
export async function assertGroupLimit(userId: string, groups: number, now: Date) {
  const { maxGroups } = await planOf(userId, now);
  if (maxGroups !== null && groups > maxGroups) {
    throw new Error(`Seu plano permite até ${maxGroups} ${maxGroups === 1 ? 'grupo' : 'grupos'} por campanha (esta tem ${groups}). Tire alguns grupos ou fale com o administrador.`);
  }
}

/** Pausa as campanhas ativas de uma conta (o envio em andamento termina). Devolve quantas pausou. */
async function pauseCampaigns(userId: string, now: Date) {
  return prisma.$transaction(async tx => {
    const active = await tx.campaign.findMany({ where: { userId, status: 'ACTIVE', deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
    let count = 0;
    for (const { id } of active) {
      await lockCampaign(tx, id);
      count += (await tx.campaign.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedAt: now, updatedAt: now } })).count;
    }
    return count;
  }, LOCKING_TRANSACTION);
}

/**
 * Contas vencidas ou pausadas com campanha ativa: pausa as campanhas. Roda a cada minuto (é o que
 * faz o vencimento valer à meia-noite) e na hora em que o administrador salva um plano.
 */
export async function pauseBlockedAccounts(now: Date, only?: string) {
  const today = new Date(`${todayOf(now)}T00:00:00.000Z`);
  const blocked = await prisma.subscription.findMany({
    where: {
      ...(only ? { userId: only } : {}),
      OR: [{ pausedAt: { not: null } }, { dueDate: { lt: today } }],
      user: { role: 'USER', campaigns: { some: { status: 'ACTIVE', deletedAt: null } } },
    },
    select: { userId: true },
  });
  let paused = 0;
  for (const { userId } of blocked) {
    const count = await pauseCampaigns(userId, now).catch(error => {
      console.error('[Planos] Não foi possível pausar as campanhas de', userId, error instanceof Error ? error.message : error);
      return 0;
    });
    if (count) console.warn('[Planos] Conta vencida ou pausada: campanhas pausadas.', userId, `(${count})`);
    paused += count;
  }
  return paused;
}

/** Liga a conferência dos planos (a cada minuto). Devolve a função que para e espera a rodada. */
export function startPlanSweep(options: { intervalMs?: number } = {}) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = currentTime().then(now => pauseBlockedAccounts(now)).then(() => undefined)
      .catch(error => console.warn('[Planos] Conferência falhou:', error instanceof Error ? error.message : error))
      .finally(() => { running = null; });
  };
  const timer = setInterval(run, options.intervalMs ?? 60_000);
  timer.unref();
  run();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

class PlanError extends Error {}

function parse(body: unknown) {
  const b = (body ?? {}) as { plan?: unknown; priceCents?: unknown; dueDate?: unknown; paused?: unknown; maxGroups?: unknown };
  const plan = b.plan === null || b.plan === undefined ? null : typeof b.plan === 'string' ? b.plan.trim() || null : undefined;
  if (plan === undefined || (plan && plan.length > PLAN_LIMITS.plan.max)) throw new PlanError(`Nome do plano: até ${PLAN_LIMITS.plan.max} caracteres.`);
  const whole = (value: unknown, min: number, max: number, message: string) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new PlanError(message);
    return value;
  };
  const priceCents = whole(b.priceCents, 0, PLAN_LIMITS.priceCents.max, 'Valor inválido.');
  const { min, max } = PLAN_LIMITS.maxGroups;
  const maxGroups = whole(b.maxGroups, min, max, `Grupos por campanha: use um número entre ${min} e ${max}, ou deixe sem limite.`);
  let dueDate: Date | null = null;
  if (b.dueDate !== null && b.dueDate !== undefined) {
    if (typeof b.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) || !DateTime.fromISO(b.dueDate).isValid) throw new PlanError('Vencimento inválido.');
    dueDate = new Date(`${b.dueDate}T00:00:00.000Z`);
  }
  if (typeof b.paused !== 'boolean') throw new PlanError('Diga se a conta fica pausada.');
  return { plan, priceCents, dueDate, maxGroups, paused: b.paused };
}

/** O plano como o administrador enxerga (com o valor). */
const adminView = (row: Row | null, today: string) => ({
  plan: row?.plan ?? null, priceCents: row?.priceCents ?? null, dueDate: isoDate(row?.dueDate ?? null),
  paused: Boolean(row?.pausedAt), maxGroups: row?.maxGroups ?? null, state: planState(row, today),
});
export const subscriptionSummary = adminView;

export function registerPlanRoutes(app: FastifyInstance) {
  // O plano da própria conta: o painel avisa do vencimento e a tela Minha conta mostra os limites.
  app.get('/api/plan', async request => {
    const { blocked, ...plan } = await planOf(request.user!.id, await currentTime());
    return { ...plan, message: blocked, dueSoonDays: DUE_SOON_DAYS };
  });

  const guard = { preHandler: requireSuperAdmin };
  const target = async (id: string) => prisma.user.findUnique({ where: { id }, select: { id: true, role: true, subscription: true } });

  app.get('/api/admin/users/:id/plan', guard, async (request, reply) => {
    const user = await target((request.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    return { ...adminView(user.subscription, todayOf(await currentTime())), limits: PLAN_LIMITS };
  });

  app.put('/api/admin/users/:id/plan', guard, async (request, reply) => {
    const user = await target((request.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    if (user.role === 'SUPER_ADMIN') return reply.code(400).send({ error: 'Administrador não tem plano: a conta nunca vence nem é pausada.' });
    let input: ReturnType<typeof parse>;
    try { input = parse(request.body); }
    catch (error) {
      if (error instanceof PlanError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const now = await currentTime();
    const { paused, ...fields } = input;
    // Pausar de novo não muda a data da pausa; despausar zera.
    const data = { ...fields, pausedAt: paused ? user.subscription?.pausedAt ?? now : null };
    const saved = await prisma.subscription.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, ...data } });
    // Vencida ou pausada a partir de agora: as campanhas param já, sem esperar a conferência.
    const pausedCampaigns = await pauseBlockedAccounts(now, user.id);
    return { ...adminView(saved, todayOf(now)), limits: PLAN_LIMITS, pausedCampaigns };
  });
}
