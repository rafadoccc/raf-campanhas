import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, inQuietHours, quietEndAfter, ruleBlock, localDay, drawInterval, minimumInterval, maximumInterval, SEND_INTERVAL, TYPICAL_INTERVAL_SECONDS, type SendingRules } from '@campaign/database';
import { forecastQueue, type ForecastItem } from './queue-forecast';

// Horário de São Paulo (UTC-3): sp('2026-10-01', '23:30') = 2026-10-02T02:30Z.
const sp = (day: string, clock: string) => new Date(`${day}T${clock}:00-03:00`);
const rules: SendingRules = { ...DEFAULT_RULES }; // 22:00 às 08:00, 150/dia, 2 h por grupo

test('padrões pedidos pelo dono: silêncio 22h-8h, 150 envios/dia, 2 h por grupo, pausa automática', () => {
  assert.deepEqual(DEFAULT_RULES, { quietStart: 22 * 60, quietEnd: 8 * 60, dailyLimit: 150, groupGapMinutes: 120, autoPause: true });
});

test('janela de silêncio vira a meia-noite e termina às 08:00 em ponto', () => {
  assert.equal(inQuietHours(rules, sp('2026-10-01', '21:59')), false);
  assert.equal(inQuietHours(rules, sp('2026-10-01', '22:00')), true);
  assert.equal(inQuietHours(rules, sp('2026-10-01', '23:30')), true);
  assert.equal(inQuietHours(rules, sp('2026-10-02', '07:59')), true);
  assert.equal(inQuietHours(rules, sp('2026-10-02', '08:00')), false);
  assert.equal(quietEndAfter(rules, sp('2026-10-01', '23:30'))?.getTime(), sp('2026-10-02', '08:00').getTime(), 'de noite: 08:00 do dia seguinte');
  assert.equal(quietEndAfter(rules, sp('2026-10-02', '03:00'))?.getTime(), sp('2026-10-02', '08:00').getTime(), 'de madrugada: 08:00 do mesmo dia');
  const lunch = { ...rules, quietStart: 12 * 60, quietEnd: 14 * 60 };
  assert.equal(inQuietHours(lunch, sp('2026-10-01', '13:00')), true, 'janela no mesmo dia também vale');
  assert.equal(inQuietHours(lunch, sp('2026-10-01', '23:00')), false);
  assert.equal(inQuietHours({ ...rules, quietStart: null, quietEnd: null }, sp('2026-10-01', '23:00')), false, 'desligada');
});

test('limite do dia: segura até o dia seguinte, respeitando o silêncio', () => {
  const at = sp('2026-10-01', '15:00');
  assert.equal(ruleBlock(rules, at, 149, null), null, 'ainda cabe um');
  const block = ruleBlock(rules, at, 150, null);
  assert.equal(block?.reason, 'daily');
  assert.equal(block?.until.getTime(), sp('2026-10-02', '08:00').getTime(), 'meia-noite cai no silêncio: 08:00');
  assert.equal(ruleBlock({ ...rules, quietStart: null, quietEnd: null }, at, 150, null)?.until.getTime(), sp('2026-10-02', '00:00').getTime());
  assert.equal(ruleBlock({ ...rules, dailyLimit: null }, at, 5000, null), null, 'desligado');
});

test('intervalo por grupo: 2 h depois do último envio ao grupo; se cair no silêncio, 08:00', () => {
  const at = sp('2026-10-01', '11:00');
  const block = ruleBlock(rules, at, 0, sp('2026-10-01', '10:00'));
  assert.equal(block?.reason, 'group');
  assert.equal(block?.until.getTime(), sp('2026-10-01', '12:00').getTime());
  assert.equal(ruleBlock(rules, sp('2026-10-01', '12:00'), 0, sp('2026-10-01', '10:00')), null, 'passou 2 h: sai');
  const late = ruleBlock(rules, sp('2026-10-01', '21:30'), 0, sp('2026-10-01', '21:00'));
  assert.equal(late?.until.getTime(), sp('2026-10-02', '08:00').getTime(), '23:00 cai no silêncio');
  assert.equal(ruleBlock({ ...rules, groupGapMinutes: null }, at, 0, sp('2026-10-01', '10:59')), null, 'desligado');
});

test('intervalo sorteado a cada envio entre 1 min 45 s e 3 min, ignorando o que a campanha tinha', () => {
  assert.deepEqual(SEND_INTERVAL, { min: 105, max: 180 });
  assert.equal(drawInterval(600, () => 0), 105, 'menor sorteio');
  assert.equal(drawInterval(600, () => 0.9999), 180, 'maior sorteio');
  const draws = new Set(Array.from({ length: 300 }, () => drawInterval(120)));
  assert.ok([...draws].every(s => s >= 105 && s <= 180), 'sempre dentro da faixa');
  assert.ok(draws.size > 20, 'varia de verdade (não é um ritmo fixo)');
  assert.equal(minimumInterval(600), 105);
  assert.equal(maximumInterval(60), 180);
  assert.equal(TYPICAL_INTERVAL_SECONDS, 143, 'média usada nas previsões');
});

test('dia em São Paulo, não em UTC', () => {
  assert.equal(localDay(sp('2026-10-01', '23:30')), '2026-10-01', 'em UTC já seria dia 2');
});

test('previsão: envio segurado pela regra mostra o motivo e nunca aparece como atrasado', () => {
  const now = sp('2026-10-01', '23:00');
  const item = (id: string, sequence: number, groupId: string, scheduled = '21:00'): ForecastItem => ({ id, sequence, status: 'PENDING', provider: 'baileys', scheduledAt: sp('2026-10-01', scheduled), attemptedAt: null, attempts: 0, groupId });
  const result = forecastQueue([item('a', 0, 'g1'), item('b', 1, 'g2')], { status: 'ACTIVE', nextAvailableAt: null, intervalSeconds: 120 }, now, true, 3,
    { rules, usedToday: 10, lastSentByGroup: new Map() });
  assert.equal(result.get('a')?.expectedAt.getTime(), sp('2026-10-02', '08:00').getTime());
  assert.equal(result.get('a')?.lateMinutes, 0, 'horário de silêncio não é atraso');
  assert.equal(result.get('a')?.reason, 'Horário de silêncio · sai amanhã às 08:00');
  assert.equal(result.get('b')?.expectedAt.getTime(), sp('2026-10-02', '08:00').getTime() + TYPICAL_INTERVAL_SECONDS * 1000, 'o seguinte, um intervalo depois');

  const group = forecastQueue([item('a', 0, 'g1', '10:30')], { status: 'ACTIVE', nextAvailableAt: null, intervalSeconds: 120 }, sp('2026-10-01', '11:00'), true, 3,
    { rules, usedToday: 0, lastSentByGroup: new Map([['g1', sp('2026-10-01', '10:00')]]) });
  assert.equal(group.get('a')?.reason, 'Intervalo de 2 h neste grupo · sai às 12:00');
});
