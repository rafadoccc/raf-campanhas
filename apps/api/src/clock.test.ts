import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceClock, TIME_ZONE } from '@campaign/database';

test('external UTC corrects a host 12h ahead and formats 05:00, not 17:00', async () => {
  let tick = 0; let online = true;
  const epoch = Date.parse('2026-09-20T08:00:00Z');
  const clock = new ReferenceClock((async () => {
    if (!online) throw Error('offline');
    return new Response(null, { headers: { date: new Date(epoch).toUTCString() } });
  }) as typeof fetch, () => tick, () => epoch + 12 * 3600000);
  assert.equal((await clock.now()).getTime(), epoch);
  assert.equal(new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(await clock.now()), '05:00');
  online = false; tick = 7200000;
  assert.equal((await clock.now()).getTime(), epoch + tick);
  assert.equal((await clock.now()).getTime(), epoch + tick);
});

test('saved calibration survives restart offline; no reference is explicitly marked unverified', async () => {
  const epoch = Date.parse('2026-09-20T08:00:00Z');
  let saved: { offset: number; verifiedAt: number } | undefined;
  const cache = { load: async () => saved, save: async (s: NonNullable<typeof saved>) => { saved = s; } };
  const request = (async () => new Response(null, { headers: { date: new Date(epoch).toUTCString() } })) as typeof fetch;
  await new ReferenceClock(request, () => 0, () => epoch + 43200000, cache).now();
  const offline = (async () => { throw Error('offline'); }) as typeof fetch;
  const restarted = new ReferenceClock(offline, () => 0, () => epoch + 43200000 + 60000, cache);
  assert.equal((await restarted.now()).getTime(), epoch + 60000);
  assert.equal(restarted.status().source, 'cache');
  const cold = new ReferenceClock(offline, () => 0, () => epoch);
  assert.equal((await cold.now()).getTime(), epoch);
  assert.equal(cold.status().synchronized, false);
});

test('divergent external references cannot overwrite the server fallback', async () => {
  let call = 0;
  const clock = new ReferenceClock((async () => new Response(null, { headers: { date: ++call === 1 ? 'Sun, 20 Sep 2026 08:00:00 GMT' : 'Sun, 20 Sep 2026 20:00:00 GMT' } })) as typeof fetch, () => 0, () => 1000);
  assert.equal((await clock.now()).getTime(), 1000);
  assert.equal(clock.status().synchronized, false);
});
