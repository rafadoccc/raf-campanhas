import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastQueue, type ForecastItem } from './queue-forecast';

const T0 = new Date('2026-09-22T17:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const item = (id: string, sequence: number, scheduledMin: number, extra: Partial<ForecastItem> = {}): ForecastItem =>
  ({ id, sequence, status: 'PENDING', provider: 'baileys', scheduledAt: at(scheduledMin), attemptedAt: null, attempts: 0, ...extra });
const active = { status: 'ACTIVE', nextAvailableAt: null, intervalSeconds: 180 };

test('em dia: cada envio sai no horário previsto e sem motivo de espera', () => {
  const result = forecastQueue([item('a', 0, 3), item('b', 1, 6)], active, T0, true, 3);
  assert.deepEqual(result.get('a'), { expectedAt: at(3), lateMinutes: 0, reason: null });
  assert.equal(result.get('b')?.expectedAt.getTime(), at(6).getTime());
});

test('o intervalo empurra a previsão, mas não é atraso', () => {
  // O envio anterior terminou tarde: o próximo só sai 3 min depois dele. Previsão certa, sem 'Atrasado'.
  const result = forecastQueue([item('a', 0, 0), item('b', 1, 3)], { ...active, nextAvailableAt: at(2) }, T0, true, 3);
  assert.equal(result.get('a')?.expectedAt.getTime(), at(2).getTime());
  assert.equal(result.get('a')?.lateMinutes, 0);
  assert.equal(result.get('a')?.reason, 'Aguardando o intervalo entre envios do número');
  assert.equal(result.get('b')?.expectedAt.getTime(), at(5).getTime());
  assert.equal(result.get('b')?.lateMinutes, 0);
  assert.equal(result.get('b')?.reason, null);
});

test('campanha recém-iniciada: nenhum envio aparece como atrasado', () => {
  // Fila única de 20 grupos, 1º saindo há 40 s: todo o resto vai escorregar alguns segundos.
  const queue = Array.from({ length: 20 }, (_, i) => item(`g${i}`, i, i * 3, i === 0 ? { status: 'PROCESSING', attemptedAt: new Date(T0.getTime() + 20_000), attempts: 1 } : {}));
  const result = forecastQueue(queue, { ...active, nextAvailableAt: at(3) }, new Date(T0.getTime() + 40_000), true, 3);
  assert.equal([...result.values()].filter(w => w.lateMinutes > 0).length, 0);
  assert.ok(result.get('g1')!.expectedAt.getTime() >= at(3).getTime(), 'o 2º sai um intervalo depois do 1º');
});

test('o próximo passou do horário sem sair: só ele fica atrasado, com o motivo', () => {
  const result = forecastQueue([item('a', 0, -5), item('b', 1, -2), item('c', 2, 1)], active, T0, false, 3);
  assert.equal(result.get('a')?.lateMinutes, 5);
  assert.match(result.get('a')?.reason ?? '', /desconectado/);
  assert.equal(result.get('b')?.lateMinutes, 0, 'os seguintes ainda não perderam a vez');
  assert.equal(result.get('c')?.lateMinutes, 0);
  // Dentro da folga (o despachante confere a cada 5 s) ainda não é atraso.
  assert.equal(forecastQueue([item('a', 0, -0.5)], active, T0, true, 3).get('a')?.lateMinutes, 0);
});

test('vencido e com conexão: saindo agora', () => {
  const result = forecastQueue([item('a', 0, -4)], active, T0, true, 3);
  assert.equal(result.get('a')?.reason, 'Atrasado 4 min · saindo agora');
});

test('desconectado: explica que envia assim que reconectar', () => {
  const result = forecastQueue([item('a', 0, -1)], active, T0, false, 3);
  assert.match(result.get('a')?.reason ?? '', /desconectado · envia assim que reconectar/);
});

test('reenvio agendado não segura os seguintes: eles saem antes, na ordem', () => {
  const retry = item('r', 0, 5, { attempts: 1 });
  const result = forecastQueue([retry, item('b', 1, 0), item('c', 2, 3)], active, T0, true, 3);
  assert.equal(result.get('b')?.expectedAt.getTime(), T0.getTime());
  assert.equal(result.get('c')?.expectedAt.getTime(), at(3).getTime());
  assert.equal(result.get('r')?.expectedAt.getTime(), at(6).getTime(), 'depois do intervalo do anterior');
  assert.equal(result.get('r')?.reason, 'Nova tentativa (2 de 3)');
});

test('envio em andamento há muito tempo e campanha pausada', () => {
  const running = item('p', 0, -10, { status: 'PROCESSING', attemptedAt: at(-5) });
  const result = forecastQueue([running, item('b', 1, 3)], active, T0, true, 3);
  assert.match(result.get('p')?.reason ?? '', /Enviando há 5 min/);
  assert.equal(result.get('b')?.expectedAt.getTime(), at(3).getTime(), 'espera o intervalo depois do que está saindo');
  assert.equal(forecastQueue([item('a', 0, 1)], { ...active, status: 'PAUSED' }, T0, true, 3).get('a')?.reason, 'Campanha pausada');
  assert.equal(forecastQueue([item('a', 0, 1)], { ...active, status: 'COMPLETED' }, T0, true, 3).size, 0);
});
