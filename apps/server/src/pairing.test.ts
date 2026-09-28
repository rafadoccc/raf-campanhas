import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompanionRegRefresh, withAdvSecret } from './pairing';
import { closeAction, CODE, MAX_RETRY_DELAY_MS, retryDelay } from './connection-policy';

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

test('only a real logout (401) deletes the session; server hiccups (500) never do', () => {
  const logout = closeAction(CODE.loggedOut, '', 0);
  assert.equal(logout.kind === 'stop' && logout.clearSession, true, 'aparelho removido no celular: sessão inútil');
  // 500 é o código genérico do Baileys para erro de fluxo sem código: instabilidade passageira.
  assert.deepEqual(closeAction(CODE.badSession, 'Stream Errored (unknown)', 0), { kind: 'reconnect', delayMs: 1000, countsAsRetry: true });
  for (const code of [CODE.multideviceMismatch, CODE.connectionReplaced, CODE.forbidden]) {
    const action = closeAction(code, '', 0);
    assert.equal(action.kind === 'stop' && action.clearSession, false, `código ${code} não apaga a sessão`);
  }
});

test('network drops back off exponentially and never give up; at most one attempt per minute', () => {
  assert.deepEqual(closeAction(CODE.connectionClosed, 'Connection Closed', 0), { kind: 'reconnect', delayMs: 1000, countsAsRetry: true });
  assert.deepEqual(closeAction(CODE.timedOut, 'Connection was lost', 3), { kind: 'reconnect', delayMs: 8000, countsAsRetry: true });
  assert.deepEqual(closeAction(undefined, undefined, 5), { kind: 'reconnect', delayMs: 32000, countsAsRetry: true });
  for (const retries of [6, 20, 500]) {
    const later = closeAction(CODE.connectionClosed, '', retries);
    assert.deepEqual(later, { kind: 'reconnect', delayMs: MAX_RETRY_DELAY_MS, countsAsRetry: true }, `tentativa ${retries}`);
  }
  assert.equal(retryDelay(1000), MAX_RETRY_DELAY_MS);
});
