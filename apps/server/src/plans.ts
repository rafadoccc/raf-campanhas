import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { prisma, currentTime, lockCampaign, LOCKING_TRANSACTION, TIME_ZONE } from '@campaign/database';
import { requireSuperAdmin } from './auth';
import type { Prisma } from '@prisma/client';

type PlanDb = Pick<Prisma.TransactionClient, 'user' | 'campaign'>;

// Plano da conta (ADR-050). O administrador define, por conta: nome do plano, valor combinado,
// vencimento, pausa e quantos grupos cabem numa campanha. A cobrança acontece fora do sistema
// (Pix, link de pagamento); aqui fica só o resultado dela.
//
// Conta vencida ou pausada continua ENTRANDO e vendo tudo: o que ela não faz é enviar. As
// campanhas ativas são pausadas (do mesmo jeito do botão Pausar) e não podem ser iniciadas nem
// retomadas até o administrador renovar. Administrador não tem plano: nunca é bloqueado.

export type PlanState = 'active' | 'paused' | 'expired';
export const PLAN_LIMITS = { maxGroups: { min: 1, max: 500 }, maxCampaigns: { min: 1, max: 500 }, priceCents: { max: 10_000_000 }, plan: { max: 40 } } as const;
/** Campanhas que uma conta mantém quando o administrador não definiu outro número (ADR-054). */
export const DEFAULT_MAX_CAMPAIGNS = 8;
/**
 * O padrão que a fila de pedidos aplica. No banco de teste descartável fica desligado (como as
 * regras de envio padrão): os testes criam dezenas de campanhas na mesma conta. Limite definido
 * pelo administrador vale em qualquer banco.
 */
const defaultMaxCampaigns = () => (process.env.CAMPAIGN_TEST_DATABASE ? null : DEFAULT_MAX_CAMPAIGNS);
/** Faltando este tanto de dias (ou menos), o painel avisa o cliente do vencimento. */
export const DUE_SOON_DAYS = 5;

type Row = { plan: string | null; priceCents: number | null; dueDate: Date | null; pausedAt: Date | null; maxGroups: number | null; maxCampaigns: number | null };

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
export async function planOf(userId: string, now: Date, db: PlanDb = prisma) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, subscription: true } });
  const admin = user?.role === 'SUPER_ADMIN';
  const row = admin ? null : user?.subscription ?? null;
  const today = todayOf(now);
  const state = planState(row, today);
  const dueDate = isoDate(row?.dueDate ?? null);
  const daysLeft = dueDate ? Math.round((Date.parse(dueDate) - Date.parse(today)) / 86_400_000) : null;
  const blocked = state === 'paused' ? BLOCK.paused() : state === 'expired' ? BLOCK.expired(dueDate!) : null;
  // Administrador não tem limite; conta sem número definido usa o padrão do sistema.
  const maxCampaigns = admin ? null : row?.maxCampaigns ?? defaultMaxCampaigns();
  return { plan: row?.plan ?? null, dueDate, daysLeft, state, maxGroups: row?.maxGroups ?? null, maxCampaigns, blocked };
}

/** Recusa (com a mensagem para a tela) se a conta não pode enviar agora. */
export async function assertCanSend(userId: string, now: Date, db: PlanDb = prisma) {
  const { blocked } = await planOf(userId, now, db);
  if (blocked) throw new Error(blocked);
}

/** Recusa se a campanha tem mais grupos do que o plano permite. */
export async function assertGroupLimit(userId: string, groups: number, now: Date, db: PlanDb = prisma) {
  const { maxGroups } = await planOf(userId, now, db);
  if (maxGroups !== null && groups > maxGroups) {
    throw new Error(`Seu plano permite até ${maxGroups} ${maxGroups === 1 ? 'grupo' : 'grupos'} por campanha (esta tem ${groups}). Tire alguns grupos ou fale com o administrador.`);
  }
}

/** As campanhas que contam no limite: as da lista principal (fora arquivadas, excluídas e modelos). */
export const countedCampaigns = (userId: string) => ({ userId, deletedAt: null, isTemplate: false, archivedAt: null });

/**
 * Recusa se a conta já está no limite de campanhas (ADR-054). Chame DENTRO da transação que cria,
 * copia ou desarquiva, depois da trava da conta (`SELECT … FOR UPDATE` em User): dois pedidos ao
 * mesmo tempo não passam os dois.
 */
export async function assertCampaignLimit(userId: string, now: Date, db: PlanDb) {
  const { maxCampaigns } = await planOf(userId, now, db);
  if (maxCampaigns === null) return;
  if (await db.campaign.count({ where: countedCampaigns(userId) }) >= maxCampaigns) {
    throw new Error(`Você chegou ao limite de ${maxCampaigns} ${maxCampaigns === 1 ? 'campanha' : 'campanhas'}. Arquive ou exclua uma para criar outra.`);
  }
}

/** Pausa as campanhas ativas de uma conta (o envio em andamento termina). Devolve quantas pausou. */
async function pauseCampaigns(tx: Prisma.TransactionClient, userId: string, now: Date) {
  const active = await tx.campaign.findMany({ where: { userId, status: 'ACTIVE', deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
  let count = 0;
  for (const { id } of active) {
    await lockCampaign(tx, id);
    count += (await tx.campaign.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedAt: now, updatedAt: now } })).count;
  }
  return count;
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
    const count = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
      // A lista é apenas candidata: uma renovação/promoção pode ter ocorrido enquanto esperamos.
      if (!(await planOf(userId, now, tx)).blocked) return 0;
      return pauseCampaigns(tx, userId, now);
    }, LOCKING_TRANSACTION).catch(error => {
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

class PlanError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function parse(body: unknown) {
  const b = (body ?? {}) as { plan?: unknown; priceCents?: unknown; dueDate?: unknown; paused?: unknown; maxGroups?: unknown; maxCampaigns?: unknown };
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
  const campaigns = PLAN_LIMITS.maxCampaigns;
  // null = volta ao padrão do sistema (campo que versões antigas da tela não enviam).
  const maxCampaigns = whole(b.maxCampaigns, campaigns.min, campaigns.max, `Campanhas por conta: use um número entre ${campaigns.min} e ${campaigns.max}.`);
  let dueDate: Date | null = null;
  if (b.dueDate !== null && b.dueDate !== undefined) {
    if (typeof b.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) || !DateTime.fromISO(b.dueDate).isValid) throw new PlanError('Vencimento inválido.');
    dueDate = new Date(`${b.dueDate}T00:00:00.000Z`);
  }
  if (typeof b.paused !== 'boolean') throw new PlanError('Diga se a conta fica pausada.');
  return { plan, priceCents, dueDate, maxGroups, maxCampaigns, paused: b.paused };
}

/** O plano como o administrador enxerga (com o valor). */
const adminView = (row: Row | null, today: string) => ({
  plan: row?.plan ?? null, priceCents: row?.priceCents ?? null, dueDate: isoDate(row?.dueDate ?? null),
  paused: Boolean(row?.pausedAt), maxGroups: row?.maxGroups ?? null, state: planState(row, today),
  // O número que vale para a conta (o definido ou o padrão) e se é o padrão.
  maxCampaigns: row?.maxCampaigns ?? DEFAULT_MAX_CAMPAIGNS, maxCampaignsIsDefault: row?.maxCampaigns == null,
});
export const subscriptionSummary = adminView;

export function registerPlanRoutes(app: FastifyInstance) {
  // O plano da própria conta: o painel avisa do vencimento e a tela Minha conta mostra os limites.
  app.get('/api/plan', async request => {
    const { blocked, ...plan } = await planOf(request.user!.id, await currentTime());
    const campaigns = await prisma.campaign.count({ where: countedCampaigns(request.user!.id) });
    return { ...plan, campaigns, message: blocked, dueSoonDays: DUE_SOON_DAYS };
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
    const { paused, ...fields } = input;
    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`;
        const current = await tx.user.findUnique({ where: { id: user.id }, select: { role: true, subscription: true } });
        if (!current) throw new PlanError('Usuário não encontrado.', 404);
        if (current.role === 'SUPER_ADMIN') throw new PlanError('Administrador não tem plano: a conta nunca vence nem é pausada.');
        const now = await currentTime();
        // Plano e pausa são salvos juntos, na mesma ordem de trava usada para iniciar/retomar.
        const data = { ...fields, pausedAt: paused ? current.subscription?.pausedAt ?? now : null };
        const saved = await tx.subscription.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, ...data } });
        const pausedCampaigns = planState(saved, todayOf(now)) === 'active' ? 0 : await pauseCampaigns(tx, user.id, now);
        return { ...adminView(saved, todayOf(now)), limits: PLAN_LIMITS, pausedCampaigns };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof PlanError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
