import type { Prisma } from '@prisma/client';
import { TIME_ZONE } from './clock';

// ─── Proteção do número (ADR-041) ───────────────────────────────────────────────
// Regras de cada conta, além do intervalo mínimo entre envios (ADR-006/035):
//   - janela de silêncio: nada sai entre quietStart e quietEnd (horário de São Paulo);
//   - limite diário: no máximo dailyLimit envios por número por dia;
//   - intervalo por grupo: o mesmo grupo não recebe de novo antes de groupGapMinutes.
// Valem só para envios reais (WhatsApp). Um envio barrado não falha: espera a regra liberar.

export type SendingRules = {
  /** Minutos desde 00:00; null (nos dois) = sem janela de silêncio. */
  quietStart: number | null;
  quietEnd: number | null;
  dailyLimit: number | null;
  groupGapMinutes: number | null;
  /** Pausar as campanhas ao ver sinal de restrição do WhatsApp (safety.ts). */
  autoPause: boolean;
  /** Início do aquecimento do número que envia (ADR-043); null/ausente = sem aquecimento. */
  warmupStartedAt?: Date | null;
};

// ─── Aquecimento de número novo (ADR-043) ───────────────────────────────────────
// Número recém-criado que já sai mandando muito parece robô de spam. Nos primeiros dias o limite
// diário é menor e sobe sozinho; depois vale o limite normal da conta.
export const WARMUP_DAYS = 7;
export const WARMUP_STEPS = [{ lastDay: 3, limit: 30 }, { lastDay: 7, limit: 80 }] as const;

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
/** Dia do aquecimento em `at` (1 = dia em que começou, horário de São Paulo); null = não está aquecendo. */
export function warmupDay(rules: SendingRules, at: Date) {
  if (!rules.warmupStartedAt) return null;
  const day = dayNumber(localDay(at)) - dayNumber(localDay(rules.warmupStartedAt)) + 1;
  return day >= 1 && day <= WARMUP_DAYS ? day : null;
}
/** Limite de envios do número no dia de `at`: o menor entre o da conta e o do aquecimento. */
export function dailyLimitOn(rules: SendingRules, at: Date) {
  const day = warmupDay(rules, at);
  if (day === null) return rules.dailyLimit;
  const warmup = WARMUP_STEPS.find(step => day <= step.lastDay)!.limit;
  return rules.dailyLimit === null ? warmup : Math.min(rules.dailyLimit, warmup);
}

/** Padrões de quem nunca mexeu nas regras (pedido do dono, 2026-09-30). */
export const DEFAULT_RULES: SendingRules = { quietStart: 22 * 60, quietEnd: 8 * 60, dailyLimit: 150, groupGapMinutes: 120, autoPause: true };
export const RULE_LIMITS = { dailyLimit: { min: 10, max: 1000 }, groupGapMinutes: { min: 30, max: 1440 } } as const;
const OFF: SendingRules = { quietStart: null, quietEnd: null, dailyLimit: null, groupGapMinutes: null, autoPause: false };

/**
 * Regras sem configuração salva. No banco de teste descartável os padrões ficam desligados: os
 * testes de fila rodam a qualquer hora e não podem depender do relógio (como o piso de intervalo).
 */
export const defaultRules = () => (process.env.CAMPAIGN_TEST_DATABASE ? OFF : DEFAULT_RULES);

/**
 * Regras da conta. Com `accountJid`, inclui o aquecimento, que vale só se a resposta "é novo?"
 * foi dada para ESTE número (outro número conectado não herda o aquecimento do anterior).
 */
export async function rulesFor(db: Prisma.TransactionClient, userId: string, accountJid?: string | null): Promise<SendingRules> {
  const [row, session] = await Promise.all([
    db.sendingPolicy.findUnique({ where: { userId } }),
    accountJid ? db.whatsAppSession.findUnique({ where: { userId }, select: { warmupJid: true, warmupStartedAt: true } }) : null,
  ]);
  const warmupStartedAt = session?.warmupJid === accountJid ? session?.warmupStartedAt ?? null : null;
  if (!row) return { ...defaultRules(), warmupStartedAt };
  const { quietStart, quietEnd, dailyLimit, groupGapMinutes, autoPause } = row;
  return { quietStart, quietEnd, dailyLimit, groupGapMinutes, autoPause, warmupStartedAt };
}

// ─── Relógio de São Paulo ───────────────────────────────────────────────────────
const format = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function localParts(at: Date) {
  const parts = Object.fromEntries(format.formatToParts(at).map(p => [p.type, Number(p.value)])) as Record<string, number>;
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
/** Diferença do fuso naquele instante (São Paulo não tem horário de verão desde 2019, mas não supomos). */
function offsetMs(at: Date) {
  const p = localParts(at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}
/** Minutos desde a meia-noite em São Paulo. */
export function localMinute(at: Date) { const p = localParts(at); return p.hour * 60 + p.minute; }
/** Dia em São Paulo, "2026-09-30". */
export function localDay(at: Date) { const p = localParts(at); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
/** Instante do minuto `minuteOfDay` do dia de `at` (+ `days`), no horário de São Paulo. */
export function localAt(at: Date, days: number, minuteOfDay: number) {
  const p = localParts(at);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days, 0, minuteOfDay) - offsetMs(at));
}

const quietOn = (r: SendingRules) => r.quietStart !== null && r.quietEnd !== null && r.quietStart !== r.quietEnd;
/** Dentro da janela de silêncio? A janela pode virar a meia-noite (ex.: 22:00 às 08:00). */
export function inQuietHours(rules: SendingRules, at: Date) {
  if (!quietOn(rules)) return false;
  const m = localMinute(at); const start = rules.quietStart!; const end = rules.quietEnd!;
  return start < end ? m >= start && m < end : m >= start || m < end;
}
/** Fim da janela de silêncio em que `at` está (null se não está em uma). */
export function quietEndAfter(rules: SendingRules, at: Date) {
  if (!inQuietHours(rules, at)) return null;
  const end = rules.quietEnd!;
  return localAt(at, localMinute(at) < end ? 0 : 1, end);
}

export type RuleBlock = { until: Date; reason: 'quiet' | 'daily' | 'group' };

/**
 * Quando este envio pode sair pelas regras da conta; null = pode agora.
 * `usedToday`: envios do número no dia de `at`. `lastGroupSendAt`: último envio a este grupo.
 */
export function ruleBlock(rules: SendingRules, at: Date, usedToday: number, lastGroupSendAt: Date | null): RuleBlock | null {
  let t = at.getTime();
  let reason: RuleBlock['reason'] | null = null;
  const day = localDay(at);
  const limit = dailyLimitOn(rules, at); // com o aquecimento, se houver (ADR-043)
  // Uma regra pode empurrar para dentro de outra (ex.: fim do intervalo do grupo cai na
  // madrugada): repete até nenhuma mover o horário.
  for (let round = 0; round < 6; round++) {
    let moved = false;
    if (rules.groupGapMinutes && lastGroupSendAt && t < lastGroupSendAt.getTime() + rules.groupGapMinutes * 60_000) {
      t = lastGroupSendAt.getTime() + rules.groupGapMinutes * 60_000; reason ??= 'group'; moved = true;
    }
    if (limit && usedToday >= limit && localDay(new Date(t)) === day) {
      t = localAt(at, 1, 0).getTime(); reason ??= 'daily'; moved = true;
    }
    const quietEnd = quietEndAfter(rules, new Date(t));
    if (quietEnd) { t = quietEnd.getTime(); reason ??= 'quiet'; moved = true; }
    if (!moved) break;
  }
  return reason && t > at.getTime() ? { until: new Date(t), reason } : null;
}

/** Envios que o número já fez no dia de `at` (cada tentativa conta; ela pode ter saído). */
export function sendsToday(db: Prisma.TransactionClient, accountJid: string, at: Date, exceptId?: string) {
  return db.delivery.count({ where: { provider: 'baileys', attemptedAt: { gte: localAt(at, 0, 0) }, campaign: { accountJid }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
}

/** Último envio que saiu para este grupo (grupo do dono; outro dono tem outro registro). */
export async function lastGroupSend(db: Prisma.TransactionClient, groupId: string) {
  const last = await db.delivery.findFirst({ where: { groupId, status: 'SENT', provider: 'baileys', sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
  return last?.sentAt ?? null;
}
