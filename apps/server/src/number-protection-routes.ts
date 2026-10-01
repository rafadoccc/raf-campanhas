import type { FastifyInstance } from 'fastify';
import { prisma, rulesFor, sendsToday, currentTime, dailyLimitOn, warmupDay, DEFAULT_RULES, RULE_LIMITS, WARMUP_DAYS, type SendingRules } from '@campaign/database';
import { releaseRuleHolds } from './dispatcher';
import { requireSuperAdmin } from './auth';

// Proteção do número (ADR-041): as regras de envio da conta e o aviso de pausa automática.
// Tudo pelo usuário da sessão; nada do cliente escolhe de quem são as regras.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const toMinutes = (clock: string) => { const [, h, m] = HHMM.exec(clock)!; return Number(h) * 60 + Number(m); };

/** Forma da tela: horários como "22:00" e a janela ligada/desligada. */
function view(rules: SendingRules) {
  const quietOn = rules.quietStart !== null && rules.quietEnd !== null;
  return {
    quiet: { enabled: quietOn, start: toClock(rules.quietStart ?? DEFAULT_RULES.quietStart!), end: toClock(rules.quietEnd ?? DEFAULT_RULES.quietEnd!) },
    dailyLimit: rules.dailyLimit,
    groupGapMinutes: rules.groupGapMinutes,
    autoPause: rules.autoPause,
  };
}

class RuleError extends Error {}

function parse(body: unknown): SendingRules {
  const b = (body ?? {}) as { quiet?: { enabled?: unknown; start?: unknown; end?: unknown }; dailyLimit?: unknown; groupGapMinutes?: unknown; autoPause?: unknown };
  if (typeof b.quiet?.enabled !== 'boolean') throw new RuleError('Diga se a janela de silêncio fica ligada.');
  let quietStart: number | null = null; let quietEnd: number | null = null;
  if (b.quiet.enabled) {
    if (typeof b.quiet.start !== 'string' || typeof b.quiet.end !== 'string' || !HHMM.test(b.quiet.start) || !HHMM.test(b.quiet.end)) throw new RuleError('Horários da janela de silêncio inválidos (use HH:MM).');
    quietStart = toMinutes(b.quiet.start); quietEnd = toMinutes(b.quiet.end);
    if (quietStart === quietEnd) throw new RuleError('O início e o fim da janela de silêncio precisam ser diferentes.');
  }
  const number = (value: unknown, { min, max }: { min: number; max: number }, label: string) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new RuleError(`${label}: use um número entre ${min} e ${max}, ou desligue.`);
    return value;
  };
  const dailyLimit = number(b.dailyLimit, RULE_LIMITS.dailyLimit, 'Limite diário');
  const groupGapMinutes = number(b.groupGapMinutes, RULE_LIMITS.groupGapMinutes, 'Intervalo por grupo');
  if (typeof b.autoPause !== 'boolean') throw new RuleError('Diga se a pausa automática fica ligada.');
  return { quietStart, quietEnd, dailyLimit, groupGapMinutes, autoPause: b.autoPause };
}

/** `accountOf`: número conectado da conta agora (para mostrar o uso do dia). */
export function registerNumberProtectionRoutes(app: FastifyInstance, accountOf: (userId: string) => Promise<string | null>) {
  // Ver e mudar as regras é só do administrador (ADR-049): o cliente não escolhe o próprio limite.
  // As regras continuam valendo para todas as contas; o que muda é quem enxerga e ajusta.
  const adminOnly = { preHandler: requireSuperAdmin };

  app.get('/api/sending-policy', adminOnly, async request => {
    const userId = request.user!.id;
    const account = await accountOf(userId);
    const now = await currentTime();
    const rules = await rulesFor(prisma, userId, account);
    const today = account ? await sendsToday(prisma, account, now) : null;
    // Limite que vale hoje (com o aquecimento, se houver), para "hoje: 12 de 30".
    return { ...view(rules), defaults: view(DEFAULT_RULES), limits: RULE_LIMITS, today, todayLimit: dailyLimitOn(rules, now), warmup: await warmupStatus(userId, account, now) };
  });

  app.put('/api/sending-policy', adminOnly, async (request, reply) => {
    let rules: SendingRules;
    try { rules = parse(request.body); }
    catch (error) {
      if (error instanceof RuleError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const userId = request.user!.id;
    await prisma.sendingPolicy.upsert({ where: { userId }, update: rules, create: { userId, ...rules } });
    // Regra afrouxada vale na hora: a fila esquece quem estava segurando e confere de novo.
    releaseRuleHolds();
    return view(rules);
  });

  // Resposta a "Este número é novo?" (ADR-043), do número conectado agora. Sim de novo não
  // reinicia um aquecimento em andamento; Não encerra o aquecimento.
  app.post('/api/whatsapp/warmup', async (request, reply) => {
    const isNew = (request.body as { isNew?: unknown } | null)?.isNew;
    if (typeof isNew !== 'boolean') return reply.code(400).send({ error: 'Diga se o número é novo.' });
    const userId = request.user!.id;
    const account = await accountOf(userId);
    if (!account) return reply.code(409).send({ error: 'Conecte o WhatsApp primeiro.' });
    const now = await currentTime();
    const session = await prisma.whatsAppSession.findUnique({ where: { userId }, select: { warmupJid: true, warmupStartedAt: true } });
    const keep = session?.warmupJid === account && session.warmupStartedAt ? session.warmupStartedAt : null;
    const warmupStartedAt = isNew ? keep ?? now : null;
    await prisma.whatsAppSession.upsert({ where: { userId }, update: { warmupJid: account, warmupStartedAt }, create: { userId, warmupJid: account, warmupStartedAt } });
    releaseRuleHolds();
    return warmupStatus(userId, account, now);
  });

  // "Entendi" no aviso de pausa automática. As campanhas continuam pausadas até a pessoa retomar.
  app.post('/api/whatsapp/safety/dismiss', async request => {
    await prisma.whatsAppSession.updateMany({ where: { userId: request.user!.id }, data: { safetyReason: null } });
    return { ok: true };
  });
}

/**
 * Aquecimento do número conectado (ADR-043). needsAnswer = este número ainda não respondeu "é
 * novo?" (a pergunta é uma vez por número: reconectar o mesmo não pergunta de novo).
 */
export async function warmupStatus(userId: string, accountJid: string | null, now: Date) {
  if (!accountJid) return null;
  const session = await prisma.whatsAppSession.findUnique({ where: { userId }, select: { warmupJid: true, warmupStartedAt: true } });
  if (session?.warmupJid !== accountJid) return { needsAnswer: true as const };
  const rules = await rulesFor(prisma, userId, accountJid);
  const day = warmupDay(rules, now);
  return { needsAnswer: false as const, isNew: Boolean(session.warmupStartedAt), day, days: WARMUP_DAYS, limitToday: day ? dailyLimitOn(rules, now) : null };
}

/** Aviso de pausa automática ainda não dispensado (vai junto do status do WhatsApp). */
export async function safetyNotice(userId: string) {
  const session = await prisma.whatsAppSession.findUnique({ where: { userId }, select: { safetyReason: true, safetyPausedAt: true } });
  return session?.safetyReason ? { reason: session.safetyReason, at: session.safetyPausedAt } : null;
}
