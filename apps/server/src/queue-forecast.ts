import { effectiveInterval, localDay, localMinute, ruleBlock, warmupDay, dailyLimitOn, WARMUP_DAYS, type RuleBlock, type SendingRules } from '@campaign/database';

// Previsão dos envios pendentes de uma campanha: quando cada um deve sair e, se estiver
// esperando ou atrasado, por quê. Reproduz a regra do despachante (ADR-003/014): um envio por
// vez, na ordem da sequência, o intervalo contado do fim do anterior, e só envios já vencidos
// entram na frente.
//
// "Atrasado" (ADR-035) quer dizer uma coisa só: o PRÓXIMO envio da fila já podia ter saído
// (horário e intervalo cumpridos) e passou da folga sem sair — ex.: WhatsApp desconectado.
// Os envios seguintes ainda não perderam nada: mostram só a previsão. Como o intervalo conta do
// FIM do envio anterior, a previsão escorrega alguns segundos a cada envio; isso é o ritmo
// normal, não atraso (antes, uma campanha recém-iniciada aparecia inteira como "Atrasado").

export type ForecastItem = {
  id: string; status: string; sequence: number; provider: string;
  scheduledAt: Date; attemptedAt: Date | null; attempts: number; groupId?: string;
};
export type ForecastCampaign = { status: string; nextAvailableAt: Date | null; intervalSeconds: number };
export type Wait = { expectedAt: Date; lateMinutes: number; reason: string | null };
/** Regras da conta (ADR-041) e o que o número já usou: a previsão respeita as mesmas regras da fila. */
export type ForecastRules = { rules: SendingRules; usedToday: number; lastSentByGroup: Map<string, Date> };

/** Folga antes de chamar de atraso: o despachante confere a fila a cada 5 s. */
export const LATE_GRACE_MS = 60_000;

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** "08:00", ou "amanhã às 08:00" / "02/10 às 08:00" quando não é hoje (horário de São Paulo). */
function when(at: Date, now: Date) {
  const m = localMinute(at);
  const clock = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const day = localDay(at);
  if (day === localDay(now)) return `às ${clock}`;
  if (day === localDay(new Date(now.getTime() + 86_400_000))) return `amanhã às ${clock}`;
  return `${day.slice(8, 10)}/${day.slice(5, 7)} às ${clock}`;
}
function ruleReason(block: RuleBlock, rules: SendingRules, now: Date) {
  if (block.reason === 'quiet') return `Horário de silêncio · sai ${when(block.until, now)}`;
  if (block.reason === 'daily') {
    const day = warmupDay(rules, now);
    return day
      ? `Aquecendo o número (dia ${day} de ${WARMUP_DAYS}): limite de ${dailyLimitOn(rules, now)} envios hoje · continua ${when(block.until, now)}`
      : `Limite de ${dailyLimitOn(rules, now)} envios do dia atingido · continua ${when(block.until, now)}`;
  }
  const gap = rules.groupGapMinutes ?? 0;
  const label = gap % 60 ? `${gap} min` : `${gap / 60} h`;
  return `Intervalo de ${label} neste grupo · sai ${when(block.until, now)}`;
}

/** Tipo da espera, para a tela escolher um selo curto sem interpretar o texto do motivo. */
export type WaitKind = 'sending' | 'now' | 'quiet' | 'daily' | 'group' | 'retry' | 'offline' | 'paused' | 'pace' | 'scheduled';
const KINDS: [string, WaitKind][] = [
  ['Enviando', 'sending'], ['Campanha pausada', 'paused'], ['WhatsApp desconectado', 'offline'], ['Nova tentativa', 'retry'],
  ['Horário de silêncio', 'quiet'], ['Aquecendo o número', 'daily'], ['Limite de', 'daily'], ['Intervalo de', 'group'],
  ['Atrasado', 'now'], ['Saindo agora', 'now'], ['Aguardando o intervalo', 'pace'],
];
/** Os motivos são montados logo acima (ruleReason e forecastQueue): mudou o texto lá, mude aqui. */
export function waitKind(wait: Wait, status: string): WaitKind {
  if (status === 'PROCESSING') return 'sending';
  return KINDS.find(([start]) => wait.reason?.startsWith(start))?.[1] ?? 'scheduled';
}

export function forecastQueue(items: ForecastItem[], campaign: ForecastCampaign, now: Date, connected: boolean, maxAttempts: number, limits?: ForecastRules) {
  const result = new Map<string, Wait>();
  if (!['ACTIVE', 'PAUSED'].includes(campaign.status)) return result;
  const interval = effectiveInterval(campaign.intervalSeconds) * 1000;
  const paused = campaign.status === 'PAUSED';
  const pacedUntil = campaign.nextAvailableAt?.getTime() ?? 0;
  let t = Math.max(now.getTime(), pacedUntil);

  const running = items.find(item => item.status === 'PROCESSING');
  if (running) {
    const started = running.attemptedAt ?? now;
    const busy = minutes(now.getTime() - started.getTime());
    result.set(running.id, { expectedAt: started, lateMinutes: 0, reason: busy >= 2 ? `Enviando há ${busy} min · aguardando resposta do WhatsApp` : 'Enviando agora' });
    // O próximo só sai um intervalo depois que este terminar.
    t = Math.max(t, now.getTime() + interval);
  }

  const pool = items.filter(item => item.status === 'PENDING').sort((a, b) => a.sequence - b.sequence);
  let head = !running;
  // Envios do número no dia simulado (o limite diário zera na virada do dia) e último envio por grupo.
  let day = localDay(now);
  let used = limits?.usedToday ?? 0;
  const lastToGroup = new Map(limits?.lastSentByGroup ?? []);
  while (pool.length) {
    let index = pool.findIndex(item => item.scheduledAt.getTime() <= t);
    if (index < 0) {
      t = Math.min(...pool.map(item => item.scheduledAt.getTime()));
      index = pool.findIndex(item => item.scheduledAt.getTime() <= t);
    }
    const [item] = pool.splice(index, 1);
    // Proteção do número (ADR-041): a mesma regra que segura o envio na fila empurra a previsão.
    let held: string | null = null;
    let heldUntil = 0;
    if (limits && item.provider === 'baileys') {
      if (localDay(new Date(t)) !== day) { day = localDay(new Date(t)); used = 0; }
      const block = ruleBlock(limits.rules, new Date(t), used, item.groupId ? lastToGroup.get(item.groupId) ?? null : null);
      if (block) {
        t = block.until.getTime(); heldUntil = t;
        held = ruleReason(block, limits.rules, now);
        if (localDay(block.until) !== day) { day = localDay(block.until); used = 0; }
      }
      used++;
      if (item.groupId) lastToGroup.set(item.groupId, new Date(t));
    }
    // Só o próximo da fila pode estar atrasado: desde quando ele já podia sair (e uma regra da
    // conta segurando não é atraso).
    const allowedAt = Math.max(item.scheduledAt.getTime(), pacedUntil, heldUntil);
    const overdue = head && !paused ? now.getTime() - allowedAt : 0;
    const lateMinutes = overdue > LATE_GRACE_MS ? minutes(overdue) : 0;
    const nowish = t <= now.getTime() + 10_000;
    let reason: string | null = null;
    if (paused) reason = 'Campanha pausada';
    else if (item.provider === 'baileys' && !connected) reason = 'WhatsApp desconectado · envia assim que reconectar';
    else if (item.attempts > 0) reason = `Nova tentativa (${item.attempts + 1} de ${maxAttempts})`;
    else if (held && !nowish) reason = held;
    else if (nowish) reason = lateMinutes ? `Atrasado ${lateMinutes} min · saindo agora` : 'Saindo agora';
    else if (head && item.scheduledAt.getTime() <= now.getTime()) reason = 'Aguardando o intervalo entre envios do número';
    result.set(item.id, { expectedAt: new Date(t), lateMinutes, reason });
    t += interval;
    head = false;
  }
  return result;
}
