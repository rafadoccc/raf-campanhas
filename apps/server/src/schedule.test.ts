import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDeliveries } from './schedule';
const campaign = { id: 'test', provider: 'simulator', startsAt: new Date('2026-09-17'), endsAt: new Date('2026-09-18'), groups: [{ groupId: 'a' }, { groupId: 'b' }], messages: [{ content: 'one' }, { content: 'two' }], schedules: [{ time: '09:00', timezone: 'America/Sao_Paulo' }, { time: '18:00', timezone: 'America/Sao_Paulo' }] };

test('05:10 Brasilia remains a future morning slot when the reference says 05:00', () => {
  const rows = planDeliveries({ ...campaign, startsAt: new Date('2026-09-20'), endsAt: new Date('2026-09-20'), schedules: [{ time: '05:10', timezone: 'America/Sao_Paulo' }] }, new Date('2026-09-20T08:00:00Z'));
  assert.equal(rows[0].scheduledAt.toISOString(), '2026-09-20T08:10:00.000Z');
});

test('Brasilia midnight maps to 03:00 UTC regardless of host timezone', () => {
  const rows = planDeliveries({ ...campaign, startsAt: new Date('2026-09-18'), endsAt: new Date('2026-09-18'), schedules: [{ time: '00:00', timezone: 'America/Sao_Paulo' }] }, new Date('2026-09-18T02:59:00Z'));
  assert.equal(rows[0].scheduledAt.toISOString(), '2026-09-18T03:00:00.000Z');
  assert.equal(planDeliveries({ ...campaign, endsAt: new Date('2026-09-18'), schedules: [{ time: '00:00', timezone: 'America/Sao_Paulo' }] }, new Date('2026-09-18T03:00:00Z')).length, 0);
});
test('São Paulo 09:00 equals 12:00 UTC, inclusive final date, same text for every group', () => {
  const rows = planDeliveries(campaign, new Date('2026-09-16'));
  assert.equal(rows.length, 8);
  assert.equal(rows[0].scheduledAt.toISOString(), '2026-09-17T12:00:00.000Z');
  assert.equal(rows[0].messageBody, rows[1].messageBody);
  assert.equal(rows[2].messageBody, 'two');
  assert.equal(rows[7].scheduledAt.toISOString(), '2026-09-18T21:00:00.000Z');
});
test('activation/resume does not generate historical slots', () => {
  const rows = planDeliveries(campaign, new Date('2026-09-17T12:00:00Z'));
  assert.equal(rows.length, 6);
  assert.ok(rows.every(row => row.scheduledAt > new Date('2026-09-17T12:00:00Z')));
});
test('expired campaign has no new sends', () => assert.deepEqual(planDeliveries(campaign, new Date('2026-09-19')), []));
test('incomplete campaign is rejected', () => assert.throws(() => planDeliveries({ ...campaign, messages: [] })));
test('immediate queue begins now, preserves selected order and offsets each group', () => {
  const now = new Date('2026-09-18T10:00:00Z');
  const rows = planDeliveries({ ...campaign, mode: 'IMMEDIATE', intervalSeconds: 180, schedules: [] }, now);
  assert.deepEqual(rows.map(r => r.groupId), ['a', 'b']);
  assert.equal(rows[0].scheduledAt.getTime(), now.getTime());
  assert.equal(rows[1].scheduledAt.getTime() - now.getTime(), 180000);
  assert.deepEqual(rows.map(r => r.sequence), [0, 1]);
});
test('scheduled rounds serialize even if the configured times overlap', () => {
  const rows = planDeliveries({ ...campaign, intervalSeconds: 180, endsAt: campaign.startsAt, schedules: [{ time: '09:00', timezone: 'America/Sao_Paulo' }, { time: '09:01', timezone: 'America/Sao_Paulo' }] }, new Date('2026-09-16'));
  assert.equal(rows.length, 4);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].scheduledAt.getTime() - rows[i - 1].scheduledAt.getTime(), 180000);
});
