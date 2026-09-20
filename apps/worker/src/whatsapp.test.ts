import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppProvider, resolveWebVersion } from './whatsapp';

test('uses a verified protocol version', async () => {
  assert.deepEqual(await resolveWebVersion(async () => ({ version: [2, 3000, 123], isLatest: true })), [2, 3000, 123]);
});
test('rejects a stale fallback protocol version', async () => {
  await assert.rejects(resolveWebVersion(async () => ({ version: [2, 3000, 123], isLatest: false })), /versão atual/);
});
test('rejects an invalid protocol version', async () => {
  await assert.rejects(resolveWebVersion(async () => ({ version: [2, 3000, NaN], isLatest: true })), /versão atual/);
});

function fake() {
  const provider = new WhatsAppProvider();
  const sent: unknown[] = [];
  Object.assign(provider, {
    data: { state: 'connected', accountJid: '5511000000000@s.whatsapp.net' },
    socket: { groupMetadata: async () => ({}), sendMessage: async (...args: unknown[]) => { sent.push(args); return { key: { id: 'fake-id' } }; } }
  });
  return { provider, sent };
}
test('connector starts disconnected and never connects automatically', () => assert.equal(new WhatsAppProvider().status().state, 'disconnected'));
test('rejects disconnected sends', async () => { await assert.rejects(new WhatsAppProvider().send('a@g.us', 'test', null), /desconectado/); });
test('rejects a different account and individual destinations', async () => {
  const { provider, sent } = fake();
  await assert.rejects(provider.send('a@g.us', 'test', 'other'), /Número/);
  await assert.rejects(provider.send('person@s.whatsapp.net', 'test', '5511000000000@s.whatsapp.net'), /grupo/);
  assert.equal(sent.length, 0);
});
test('submits text to the selected group through provider adapter', async () => {
  const { provider, sent } = fake();
  assert.equal(await provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), 'fake-id');
  assert.deepEqual(sent, [['a@g.us', { text: 'Hello' }]]);
});
test('provider errors propagate instead of recording success', async () => {
  const { provider } = fake();
  Object.assign(provider, { socket: { groupMetadata: async () => { throw new Error('No permission'); } } });
  await assert.rejects(provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), /No permission/);
});

for (const kind of ['image', 'video'] as const) test(`${kind} and caption are exactly one provider message`, async () => {
  const { provider, sent } = fake();
  const data = Buffer.from('adapter-test-only');
  const mimeType = kind === 'image' ? 'image/png' : 'video/mp4';
  const id = await provider.send('a@g.us', 'Legenda completa', '5511000000000@s.whatsapp.net', { kind, mimeType, data });
  assert.equal(id, 'fake-id');
  assert.deepEqual(sent, [['a@g.us', { [kind]: data, caption: 'Legenda completa', mimetype: mimeType }]]);
});
