import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WhatsAppProvider, defaultSessionsDir, resolveWebVersion, groupName } from './whatsapp';

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
  assert.deepEqual(await provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), { messageId: 'fake-id', context: 'membro=? admin=? so-admins=nao participantes=?' });
  assert.deepEqual(sent, [['a@g.us', { text: 'Hello' }]]);
});
test('admin-only group without admin rights fails before anything is sent', async () => {
  const { provider, sent } = fake();
  const socket = (provider as unknown as { socket: Record<string, unknown> }).socket;
  Object.assign(socket, {
    user: { id: '5511000000000:3@s.whatsapp.net' },
    groupMetadata: async () => ({ announce: true, participants: [{ id: '5511000000000@s.whatsapp.net', admin: null }] }),
  });
  await assert.rejects(provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), (e: { code?: string }) => e.code === 'grupo:so-admins');
  assert.equal(sent.length, 0);
  // Sendo admin, o mesmo grupo recebe normalmente.
  Object.assign(socket, { groupMetadata: async () => ({ announce: true, participants: [{ id: '5511000000000@s.whatsapp.net', admin: 'admin' }] }) });
  assert.equal((await provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net')).messageId, 'fake-id');
  assert.equal(sent.length, 1);
});
test('mention all (039): native @todos when WhatsApp allows it, in text and media', async () => {
  const { provider, sent } = fake();
  const socket = (provider as unknown as { socket: Record<string, unknown> }).socket;
  Object.assign(socket, {
    user: { id: '5511000000000:3@s.whatsapp.net', lid: '999@lid' },
    groupMetadata: async () => ({ size: 4, participants: [
      { id: '5511000000000@s.whatsapp.net', admin: 'admin' },   // a própria conta (por número)
      { id: '999@lid' },                                        // a própria conta (por LID)
      { id: '5511111111111@s.whatsapp.net' },
      { id: '123456@lid' },
    ] }),
  });
  const result = await provider.send('a@g.us', 'Olá!', '5511000000000@s.whatsapp.net', null, undefined, { mentionAll: true });
  assert.deepEqual(sent[0], ['a@g.us', { text: '@all Olá!', contextInfo: { nonJidMentions: 1 } }], '@todos nativo: marcador no texto, nenhum membro listado');
  assert.match(result.context, /mencoes=todos$/);
  const data = Buffer.from('img');
  await provider.send('a@g.us', 'Oi @todos, chegou!', '5511000000000@s.whatsapp.net', { kind: 'image', mimeType: 'image/png', data }, undefined, { mentionAll: true });
  assert.deepEqual(sent[1], ['a@g.us', { image: data, mimetype: 'image/png', caption: 'Oi @all, chegou!', contextInfo: { nonJidMentions: 1 } }], 'onde o usuário escreveu @todos, o marcador fica ali');
  await provider.send('a@g.us', 'Sem marcar', '5511000000000@s.whatsapp.net');
  assert.deepEqual(sent[2], ['a@g.us', { text: 'Sem marcar' }], 'desligado: mensagem sem menções');
});
test('provider errors propagate instead of recording success', async () => {
  const { provider } = fake();
  Object.assign(provider, { socket: { groupMetadata: async () => { throw new Error('No permission'); } } });
  await assert.rejects(provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), /No permission/);
});
test('only failures before sendMessage are marked as not sent (safe to retry)', async () => {
  const { isNotSent } = await import('./send-context.js');
  const { provider } = fake();
  const socket = (provider as unknown as { socket: Record<string, unknown> }).socket;
  Object.assign(socket, { groupMetadata: async () => { throw new Error('metadata'); } });
  await assert.rejects(provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), (e: unknown) => isNotSent(e));
  Object.assign(socket, { groupMetadata: async () => ({}), sendMessage: async () => { throw new Error('Timed Out'); } });
  await assert.rejects(provider.send('a@g.us', 'Hello', '5511000000000@s.whatsapp.net'), (e: unknown) => !isNotSent(e) && /Timed Out/.test(String(e)));
  await assert.rejects(new WhatsAppProvider().send('a@g.us', 'x', null), (e: unknown) => isNotSent(e), 'desconectado: nada saiu');
});

for (const kind of ['image', 'video'] as const) test(`${kind} and caption are exactly one provider message`, async () => {
  const { provider, sent } = fake();
  const data = Buffer.from('adapter-test-only');
  const mimeType = kind === 'image' ? 'image/png' : 'video/mp4';
  const { messageId } = await provider.send('a@g.us', 'Legenda completa', '5511000000000@s.whatsapp.net', { kind, mimeType, data });
  assert.equal(messageId, 'fake-id');
  assert.deepEqual(sent, [['a@g.us', { [kind]: data, caption: 'Legenda completa', mimetype: mimeType }]]);
});
test('uses the configured session directory outside the repository', () => {
  const previous = process.env.SESSIONS_DIR;
  process.env.SESSIONS_DIR = path.join('C:', 'secure', 'raf-campanhas', 'sessions');
  try {
    assert.equal(defaultSessionsDir(), path.resolve(process.env.SESSIONS_DIR));
  } finally {
    if (previous === undefined) delete process.env.SESSIONS_DIR;
    else process.env.SESSIONS_DIR = previous;
  }
});
test('synced group names never break the sync: blank subjects fall back and long ones fit the column', () => {
  assert.equal(groupName('  Vendas   SP  ', '120363@g.us'), 'Vendas SP');
  assert.equal(groupName('', '120363999@g.us'), 'Grupo 120363999');
  assert.equal(groupName(undefined, '120363999@g.us'), 'Grupo 120363999');
  assert.equal(groupName('a'.repeat(300), 'x@g.us').length, 255);
});

test('only a paired saved session is resumed automatically on startup', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(path.join(tmpdir(), 'wa-resume-'));
  try {
    const provider = new WhatsAppProvider(base);
    assert.equal(await provider.hasPairedSession(), false, 'sem pasta de sessão');
    mkdirSync(path.join(base, 'whatsapp'));
    writeFileSync(path.join(base, 'whatsapp', 'creds.json'), JSON.stringify({ noiseKey: {} }));
    assert.equal(await provider.hasPairedSession(), false, 'credenciais ainda não pareadas');
    writeFileSync(path.join(base, 'whatsapp', 'creds.json'), JSON.stringify({ me: { id: '5511999999999:1@s.whatsapp.net' } }));
    assert.equal(await provider.hasPairedSession(), true, 'sessão pareada');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('group context at send time: member/admin found by number or LID, unknown stays "?", admin-only flagged only when certain', async () => {
  const { describeGroupForSend } = await import('./send-context.js');
  const me = { id: '5511999999999:7@s.whatsapp.net', lid: '123456789@lid' };
  const byNumber = describeGroupForSend({ announce: true, size: 30, participants: [{ id: '5511999999999@s.whatsapp.net', admin: null }] }, me);
  assert.equal(byNumber.context, 'membro=sim admin=nao so-admins=sim participantes=30');
  assert.equal(byNumber.adminOnlyWithoutPermission, true);
  const byLid = describeGroupForSend({ participants: [{ id: '123456789@lid', admin: 'admin' }] }, me);
  assert.equal(byLid.context, 'membro=sim admin=sim so-admins=nao participantes=1');
  const unknown = describeGroupForSend({ announce: true, participants: [{ id: '999@lid' }] }, me);
  assert.equal(unknown.context, 'membro=? admin=? so-admins=sim participantes=1');
  assert.equal(unknown.adminOnlyWithoutPermission, false, 'sem certeza, não afirma bloqueio');
  // Selo do painel: só admins + você é admin / não é / desconhecido (null).
  assert.deepEqual([byNumber.onlyAdmins, byNumber.isAdmin], [true, false]);
  assert.deepEqual([byLid.onlyAdmins, byLid.isAdmin], [false, true]);
  assert.deepEqual([unknown.onlyAdmins, unknown.isAdmin], [true, null]);
});

test('technical error codes are kept apart from the readable message', async () => {
  const { errorCodeOf } = await import('./dispatcher.js');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { output: { statusCode: 428 } })), 'baileys:428');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
  assert.equal(errorCodeOf(new Error('sem código')), undefined);
});
test('mention all (039): big group without admin falls back to hidden mentions', async () => {
  const { provider, sent } = fake();
  const socket = (provider as unknown as { socket: Record<string, unknown> }).socket;
  Object.assign(socket, {
    user: { id: '5511000000000:3@s.whatsapp.net' },
    groupMetadata: async () => ({ size: 40, participants: [
      { id: '5511000000000@s.whatsapp.net', admin: null },
      { id: '5511111111111@s.whatsapp.net' },
      { id: '5522222222222@s.whatsapp.net' },
    ] }),
  });
  const result = await provider.send('a@g.us', 'Olá!', '5511000000000@s.whatsapp.net', null, undefined, { mentionAll: true });
  assert.deepEqual(sent[0], ['a@g.us', { text: 'Olá!', mentions: ['5511111111111@s.whatsapp.net', '5522222222222@s.whatsapp.net'] }], 'texto intacto, marcação oculta');
  assert.match(result.context, /mencoes=2$/);
});
test('mention all (039): rules for mode, token placement and the captured sample', async () => {
  const { mentionAllMode, withMentionAllToken, mentionAllSample } = await import('./send-context.js');
  assert.equal(mentionAllMode({ participants: 32, isAdmin: false }), 'native', 'até 32 membros qualquer um pode');
  assert.equal(mentionAllMode({ participants: 33, isAdmin: false }), 'hidden', 'acima de 32 só admin');
  assert.equal(mentionAllMode({ participants: 500, isAdmin: true }), 'native');
  assert.equal(mentionAllMode({ participants: null, isAdmin: null }), 'hidden', 'sem saber, não arrisca');
  assert.equal(withMentionAllToken('Promoção hoje'), '@all Promoção hoje');
  assert.equal(withMentionAllToken('Atenção @Todos: começa às 20h', '@todos'), 'Atenção @todos: começa às 20h');
  assert.equal(withMentionAllToken('email@todos.com.br e @todosjuntos'), '@all email@todos.com.br e @todosjuntos', 'não confunde e-mail nem outra palavra');
  assert.equal(withMentionAllToken('@all @all'), '@all @all', 'só troca o primeiro');
  assert.deepEqual(mentionAllSample('Oi @todos e @5511999, até já', { nonJidMentions: 1, mentionedJid: ['x@s.whatsapp.net'] }),
    { nonJidMentions: 1, mentionedJidCount: 1, tokens: ['@todos'] }, 'guarda só o marcador, nunca o texto nem números');
});
