import { effectiveInterval } from '@campaign/database';

// Previsão dos envios pendentes de uma campanha: quando cada um deve sair e, se estiver
// esperando ou atrasado, por quê. Reproduz a regra do despachante (ADR-003/014): um envio por
// vez, na ordem da sequência, o intervalo contado do fim do anterior, e só envios já vencidos
// entram na frente.

export type ForecastItem = {
  id: string; status: string; sequence: number; provider: string;
  scheduledAt: Date; attemptedAt: Date | null; attempts: number;
};
export type ForecastCampaign = { status: string; nextAvailableAt: Date | null; intervalSeconds: number };
export type Wait = { expectedAt: Date; lateMinutes: number; reason: string | null };

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

export function forecastQueue(items: ForecastItem[], campaign: ForecastCampaign, now: Date, connected: boolean, maxAttempts: number) {
  const result = new Map<string, Wait>();
  if (!['ACTIVE', 'PAUSED'].includes(campaign.status)) return result;
  const interval = effectiveInterval(campaign.intervalSeconds) * 1000;
  const paused = campaign.status === 'PAUSED';
  let t = Math.max(now.getTime(), campaign.nextAvailableAt?.getTime() ?? 0);

  const running = items.find(item => item.status === 'PROCESSING');
  if (running) {
    const started = running.attemptedAt ?? now;
    const busy = minutes(now.getTime() - started.getTime());
    result.set(running.id, {
      expectedAt: started,
      lateMinutes: minutes(started.getTime() - running.scheduledAt.getTime()),
      reason: busy >= 2 ? `Enviando há ${busy} min · aguardando resposta do WhatsApp` : 'Enviando agora',
    });
    // O próximo só sai um intervalo depois que este terminar.
    t = Math.max(t, now.getTime() + interval);
  }

  const pool = items.filter(item => item.status === 'PENDING').sort((a, b) => a.sequence - b.sequence);
  while (pool.length) {
    let index = pool.findIndex(item => item.scheduledAt.getTime() <= t);
    if (index < 0) {
      t = Math.min(...pool.map(item => item.scheduledAt.getTime()));
      index = pool.findIndex(item => item.scheduledAt.getTime() <= t);
    }
    const [item] = pool.splice(index, 1);
    const lateMinutes = minutes(t - item.scheduledAt.getTime());
    const nowish = t <= now.getTime() + 10_000;
    let reason: string | null = null;
    if (paused) reason = 'Campanha pausada';
    else if (item.provider === 'baileys' && !connected) reason = 'WhatsApp desconectado · envia assim que reconectar';
    else if (item.attempts > 0) reason = `Nova tentativa (${item.attempts + 1} de ${maxAttempts})`;
    else if (nowish) reason = lateMinutes ? `Atrasado ${lateMinutes} min · saindo agora` : 'Saindo agora';
    else if (lateMinutes) reason = `Atrasado ${lateMinutes} min · o intervalo conta do fim do envio anterior`;
    result.set(item.id, { expectedAt: new Date(t), lateMinutes, reason });
    t += interval;
  }
  return result;
}
