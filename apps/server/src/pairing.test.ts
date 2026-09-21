import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompanionRegRefresh, withAdvSecret } from './pairing';
import { closeAction, CODE, MAX_RETRIES } from './connection-policy';

const refresh = (childTag: string) => ({ tag: 'notification', attrs: { id: '1', type: 'companion_reg_refresh' }, content: [{ tag: childTag, attrs: {} }] });

test('companion_reg_refresh rotates the adv secret of an unpaired session (both child tags)', () => {
  for (const tag of ['companion_reg_refresh', 'pair-device-rotate-qr']) {
    const creds = { advSecretKey: 'velho' };
    assert.equal(handleCompanionRegRefresh(refresh(tag), creds, () => 'novo'), 'rotated');
    assert.equal(creds.advSecretKey, 'novo');
  }
});

test('companion_reg_refresh never touches a paired session or a malformed notification', () => {
  const paired = { advSecretKey: 'valido', me: { id: '5511@s.whatsapp.net' } };
  assert.equal(handleCompanionRegRefresh(refresh('companion_reg_refresh'), paired, () => 'novo'), 'ignored_registered');
  assert.equal(paired.advSecretKey, 'valido');
  const creds = { advSecretKey: 'velho' };
  assert.equal(handleCompanionRegRefresh({ tag: 'notification', attrs: {}, content: [{ tag: 'outra', attrs: {} }] }, creds), 'ignored_malformed');
  assert.equal(handleCompanionRegRefresh({ tag: 'notification', attrs: {} }, creds), 'ignored_malformed');
  assert.equal(creds.advSecretKey, 'velho');
});

test('generated secret is 32 random bytes in base64, like the WhatsApp Web', () => {
  const creds = { advSecretKey: 'velho' };
  handleCompanionRegRefresh(refresh('companion_reg_refresh'), creds);
  assert.equal(Buffer.from(creds.advSecretKey, 'base64').length, 32);
});

test('QR payload always advertises the current adv secret and keeps the other fields', () => {
  assert.equal(withAdvSecret('REF,NOISE,IDENT,VELHO,1', 'NOVO'), 'REF,NOISE,IDENT,NOVO,1');
  // Formato inesperado: não arrisca corromper o QR.
  assert.equal(withAdvSecret('formato,desconhecido', 'NOVO'), 'formato,desconhecido');
  assert.equal(withAdvSecret('REF,NOISE,IDENT,VELHO,1', ''), 'REF,NOISE,IDENT,VELHO,1');
});

test('restart after pairing reconnects at once without spending a retry', () => {
  assert.deepEqual(closeAction(CODE.restartRequired, 'Stream Errored (restart required)', 5), { kind: 'reconnect', delayMs: 0, countsAsRetry: false });
});

test('expired QR stops with a clear message instead of looping', () => {
  const action = closeAction(CODE.timedOut, 'QR refs attempts ended', 0);
  assert.equal(action.kind, 'stop');
  assert.match(action.kind === 'stop' ? action.error : '', /QR Code expirou/);
});

test('logged out or corrupted sessions are cleared so the next connect shows a fresh QR', () => {
  for (const code of [CODE.loggedOut, CODE.badSession, CODE.multideviceMismatch]) {
    const action = closeAction(code, '', 0);
    assert.equal(action.kind === 'stop' && action.clearSession, true, `código ${code}`);
  }
  const replaced = closeAction(CODE.connectionReplaced, '', 0);
  assert.equal(replaced.kind === 'stop' && replaced.clearSession, false, 'sessão aberta em outra janela não é apagada');
});

test('network drops back off exponentially and give up after the retry budget', () => {
  assert.deepEqual(closeAction(CODE.connectionClosed, 'Connection Closed', 0), { kind: 'reconnect', delayMs: 1000, countsAsRetry: true });
  assert.deepEqual(closeAction(CODE.timedOut, 'Connection was lost', 3), { kind: 'reconnect', delayMs: 8000, countsAsRetry: true });
  assert.deepEqual(closeAction(undefined, undefined, 5), { kind: 'reconnect', delayMs: 30000, countsAsRetry: true });
  const done = closeAction(CODE.connectionClosed, '', MAX_RETRIES);
  assert.equal(done.kind, 'stop');
  assert.match(done.kind === 'stop' ? done.error : '', /internet/);
});
