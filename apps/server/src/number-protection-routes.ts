import type { FastifyInstance } from 'fastify';
import { prisma, rulesFor, sendsToday, currentTime, DEFAULT_RULES, RULE_LIMITS, type SendingRules } from '@campaign/database';
import { releaseRuleHolds } from './dispatcher';

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
  app.get('/api/sending-policy', async request => {
    const userId = request.user!.id;
    const [rules, account] = await Promise.all([rulesFor(prisma, userId), accountOf(userId)]);
    const today = account ? await sendsToday(prisma, account, await currentTime()) : null;
    return { ...view(rules), defaults: view(DEFAULT_RULES), limits: RULE_LIMITS, today };
  });

  app.put('/api/sending-policy', async (request, reply) => {
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

  // "Entendi" no aviso de pausa automática. As campanhas continuam pausadas até a pessoa retomar.
  app.post('/api/whatsapp/safety/dismiss', async request => {
    await prisma.whatsAppSession.updateMany({ where: { userId: request.user!.id }, data: { safetyReason: null } });
    return { ok: true };
  });
}

/** Aviso de pausa automática ainda não dispensado (vai junto do status do WhatsApp). */
export async function safetyNotice(userId: string) {
  const session = await prisma.whatsAppSession.findUnique({ where: { userId }, select: { safetyReason: true, safetyPausedAt: true } });
  return session?.safetyReason ? { reason: session.safetyReason, at: session.safetyPausedAt } : null;
}
