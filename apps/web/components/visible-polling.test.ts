import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePolling, connectionPollDelay } from './visible-polling';

test('hidden tab aborts in-flight fetch, cancels timers; visible resumes once; unmount stops all work', async () => {
  let visible = true; let visibility = () => {}; let removed = false; let calls = 0;
  let resolve: (delay: number | null) => void = () => {};
  let signal: AbortSignal;
  const timers = new Map<number, () => void>();
  const stop = startVisiblePolling(s => { calls++; signal = s; return new Promise(r => { resolve = r; }); }, {
    visible: () => visible, listen: f => { visibility = f; return () => { removed = true; }; },
    schedule: f => { timers.set(1, f); return 1; }, cancel: id => { timers.delete(id); }
  });
  assert.equal(calls, 1);
  visible = false; visibility(); assert.equal(signal!.aborted, true);
  resolve(2500); await Promise.resolve(); assert.equal(timers.size, 0);
  visible = true; visibility(); assert.equal(calls, 2);
  resolve(15000); await Promise.resolve(); assert.equal(timers.size, 1);
  stop(); assert.equal(timers.size, 0); assert.equal(removed, true);
  visibility(); assert.equal(calls, 2);
});

test('polling is fast only while pairing and stops in idle states', () => {
  assert.equal(connectionPollDelay('qr'), 2500);
  assert.equal(connectionPollDelay('connected'), 15000);
  assert.equal(connectionPollDelay('unavailable'), 30000);
  assert.equal(connectionPollDelay('disconnected'), null);
  assert.equal(connectionPollDelay('error'), null);
});
