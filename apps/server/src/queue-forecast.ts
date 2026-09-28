import { effectiveInterval } from '@campaign/database';

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
  scheduledAt: Date; attemptedAt: Date | null; attempts: number;
};
export type ForecastCampaign = { status: string; nextAvailableAt: Date | null; intervalSeconds: number };
export type Wait = { expectedAt: Date; lateMinutes: number; reason: string | null };

/** Folga antes de chamar de atraso: o despachante confere a fila a cada 5 s. */
export const LATE_GRACE_MS = 60_000;

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

export function forecastQueue(items: ForecastItem[], campaign: ForecastCampaign, now: Date, connected: boolean, maxAttempts: number) {
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
  while (pool.length) {
    let index = pool.findIndex(item => item.scheduledAt.getTime() <= t);
    if (index < 0) {
      t = Math.min(...pool.map(item => item.scheduledAt.getTime()));
      index = pool.findIndex(item => item.scheduledAt.getTime() <= t);
    }
    const [item] = pool.splice(index, 1);
    // Só o próximo da fila pode estar atrasado: desde quando ele já podia sair.
    const allowedAt = Math.max(item.scheduledAt.getTime(), pacedUntil);
    const overdue = head && !paused ? now.getTime() - allowedAt : 0;
    const lateMinutes = overdue > LATE_GRACE_MS ? minutes(overdue) : 0;
    const nowish = t <= now.getTime() + 10_000;
    let reason: string | null = null;
    if (paused) reason = 'Campanha pausada';
    else if (item.provider === 'baileys' && !connected) reason = 'WhatsApp desconectado · envia assim que reconectar';
    else if (item.attempts > 0) reason = `Nova tentativa (${item.attempts + 1} de ${maxAttempts})`;
    else if (nowish) reason = lateMinutes ? `Atrasado ${lateMinutes} min · saindo agora` : 'Saindo agora';
    else if (head && item.scheduledAt.getTime() <= now.getTime()) reason = 'Aguardando o intervalo entre envios do número';
    result.set(item.id, { expectedAt: new Date(t), lateMinutes, reason });
    t += interval;
    head = false;
  }
  return result;
}
