import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startRetentionSweep } from './legal';

test('retention cleanup does not overlap and shutdown waits for its active transaction', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const stop = startRetentionSweep({
    initialDelayMs: 0,
    intervalMs: 5,
    purge: async () => {
      calls++;
      entered();
      await finish;
      return { campaigns: 0, media: 0, groups: 0 };
    },
  });
  try {
    await Promise.race([started, delay(1000).then(() => { throw new Error('Limpeza não iniciou.'); })]);
    await delay(20);
    assert.equal(calls, 1, 'intervalos não criam limpezas concorrentes');
    let stopped = false;
    const draining = stop().then(() => { stopped = true; });
    await delay(10);
    assert.equal(stopped, false, 'o banco não pode fechar com a limpeza em andamento');
    release();
    await draining;
    await delay(20);
    assert.equal(calls, 1, 'nenhuma limpeza nova começa durante o encerramento');
  } finally {
    release();
    await stop();
  }
});

test('retention cleanup can be cancelled before the first run', async () => {
  let calls = 0;
  const stop = startRetentionSweep({
    initialDelayMs: 5,
    intervalMs: 10,
    purge: async () => { calls++; return { campaigns: 0, media: 0, groups: 0 }; },
  });
  await stop();
  await delay(25);
  assert.equal(calls, 0);
});
