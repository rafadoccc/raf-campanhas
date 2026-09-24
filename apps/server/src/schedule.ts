import { DateTime } from 'luxon';
import { effectiveInterval } from '@campaign/database';

export function planDeliveries(campaign: {
  id: string; startsAt: Date; endsAt: Date; provider: string;
  mode?: string; intervalSeconds?: number;
  groups: { groupId: string }[]; messages: { content: string }[];
  schedules: { time: string; timezone: string }[];
}, now = new Date()) {
  if (!campaign.messages.length || !campaign.groups.length) throw new Error('Campanha incompleta.');
  // Horários planejados já respeitam o piso de 3 minutos (ADR-028); sem intervalo informado,
  // vale 0 (compatibilidade com os testes antigos do planejador, que não passam intervalo).
  const interval = campaign.intervalSeconds === undefined ? 0 : effectiveInterval(campaign.intervalSeconds);
  if (campaign.mode === 'IMMEDIATE') return campaign.groups.map((group, sequence) => ({ campaignId: campaign.id, groupId: group.groupId, messageBody: campaign.messages[sequence % campaign.messages.length].content, scheduledAt: new Date(now.getTime() + sequence * interval * 1000), provider: campaign.provider, sequence }));
  if (!campaign.schedules.length) throw new Error('Campanha incompleta.');
  const first = DateTime.fromISO(campaign.startsAt.toISOString().slice(0, 10), { zone: 'UTC' });
  const last = DateTime.fromISO(campaign.endsAt.toISOString().slice(0, 10), { zone: 'UTC' });
  if (last.diff(first, 'days').days > 366) throw new Error('O período máximo é de 366 dias.');
  const result = [];
  let position = 0;
  let cursor = 0;
  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    for (const schedule of [...campaign.schedules].sort((a, b) => a.time.localeCompare(b.time))) {
      const local = DateTime.fromISO(`${day.toISODate()}T${schedule.time}`, { zone: schedule.timezone });
      if (!local.isValid) throw new Error('Horário ou fuso inválido.');
      const content = campaign.messages[position++ % campaign.messages.length].content;
      if (local.toMillis() <= now.getTime()) continue;
      for (const group of campaign.groups) {
        const at = Math.max(local.toMillis(), cursor);
        result.push({ campaignId: campaign.id, groupId: group.groupId, messageBody: content, scheduledAt: new Date(at), provider: campaign.provider, sequence: result.length });
        cursor = at + interval * 1000;
        if (result.length > 50000) throw new Error('Campanha excede 50 mil entregas. Reduza o período ou os grupos.');
      }
    }
  }
  return result;
}
