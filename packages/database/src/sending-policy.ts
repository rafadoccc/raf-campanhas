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
};

/** Padrões de quem nunca mexeu nas regras (pedido do dono, 2026-09-30). */
export const DEFAULT_RULES: SendingRules = { quietStart: 22 * 60, quietEnd: 8 * 60, dailyLimit: 150, groupGapMinutes: 120, autoPause: true };
export const RULE_LIMITS = { dailyLimit: { min: 10, max: 1000 }, groupGapMinutes: { min: 30, max: 1440 } } as const;
const OFF: SendingRules = { quietStart: null, quietEnd: null, dailyLimit: null, groupGapMinutes: null, autoPause: false };

/**
 * Regras sem configuração salva. No banco de teste descartável os padrões ficam desligados: os
 * testes de fila rodam a qualquer hora e não podem depender do relógio (como o piso de intervalo).
 */
export const defaultRules = () => (process.env.CAMPAIGN_TEST_DATABASE ? OFF : DEFAULT_RULES);

export async function rulesFor(db: Prisma.TransactionClient, userId: string): Promise<SendingRules> {
  const row = await db.sendingPolicy.findUnique({ where: { userId } });
  if (!row) return defaultRules();
  const { quietStart, quietEnd, dailyLimit, groupGapMinutes, autoPause } = row;
  return { quietStart, quietEnd, dailyLimit, groupGapMinutes, autoPause };
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
  // Uma regra pode empurrar para dentro de outra (ex.: fim do intervalo do grupo cai na
  // madrugada): repete até nenhuma mover o horário.
  for (let round = 0; round < 6; round++) {
    let moved = false;
    if (rules.groupGapMinutes && lastGroupSendAt && t < lastGroupSendAt.getTime() + rules.groupGapMinutes * 60_000) {
      t = lastGroupSendAt.getTime() + rules.groupGapMinutes * 60_000; reason ??= 'group'; moved = true;
    }
    if (rules.dailyLimit && usedToday >= rules.dailyLimit && localDay(new Date(t)) === day) {
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
