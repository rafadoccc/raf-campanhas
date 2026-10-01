import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useDurableAuthState, peekSessionJson } from './auth-state';
import { SessionKeyError, isSealed, openText, sealText, sessionEncryptionEnabled } from './session-crypto';
import { WhatsAppProvider } from './whatsapp';

// Sessão do WhatsApp cifrada em repouso (ADR-046). O que estes testes protegem, na ordem de
// importância: (1) chave errada ou ausente NUNCA faz o sistema descartar uma sessão boa;
// (2) sem SESSION_KEY nada muda; (3) com ela, nenhum arquivo da sessão fica legível no disco.

const baileys = () => import('@whiskeysockets/baileys');
const folder = () => mkdtempSync(path.join(tmpdir(), 'wa-cifra-'));
const quiet = () => undefined;
const KEY = 'chave-de-teste-com-mais-de-32-caracteres-aleatorios';
const OTHER = 'outra-chave-tambem-com-mais-de-32-caracteres-xyz';
const ME = '5511999990000:7@s.whatsapp.net';

/** Roda com SESSION_KEY definida (ou ausente) e devolve o ambiente como estava. */
async function withKey<T>(key: string | undefined, run: () => Promise<T>) {
  const previous = process.env.SESSION_KEY;
  if (key === undefined) delete process.env.SESSION_KEY; else process.env.SESSION_KEY = key;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.SESSION_KEY; else process.env.SESSION_KEY = previous; }
}
async function plainSession(dir: string) {
  const { initAuthCreds, BufferJSON } = await baileys();
  writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ ...initAuthCreds(), me: { id: ME, name: 'Teste' } }, BufferJSON.replacer));
  writeFileSync(path.join(dir, 'session-5511999990000.0.json'), JSON.stringify({ chave: 'valor-secreto' }));
}

test('crypto (046): off by default; a key shorter than 32 characters is refused', async () => {
  await withKey(undefined, async () => {
    assert.equal(sessionEncryptionEnabled(), false);
    assert.equal(sealText('{"a":1}'), '{"a":1}', 'sem chave grava como sempre');
    assert.equal(openText('{"a":1}'), '{"a":1}');
  });
  await withKey('curta', async () => { assert.throws(() => sealText('x'), SessionKeyError); });
});

test('crypto (046): sealed text round-trips, differs each time and never opens with another key', async () => {
  const sealed = await withKey(KEY, async () => {
    const one = sealText('{"segredo":"valor"}');
    assert.ok(isSealed(one));
    assert.ok(!one.includes('segredo'));
    assert.notEqual(one, sealText('{"segredo":"valor"}'), 'IV novo a cada gravação');
    assert.equal(openText(one), '{"segredo":"valor"}');
    return one;
  });
  await withKey(OTHER, async () => { assert.throws(() => openText(sealed), /outra SESSION_KEY/); });
  await withKey(undefined, async () => { assert.throws(() => openText(sealed), /SESSION_KEY não foi definida/); });
  // Arquivo adulterado: a conferência de integridade recusa.
  await withKey(KEY, async () => { assert.throws(() => openText(`${sealed.slice(0, -6)}AAAAAA`), SessionKeyError); });
});

test('crypto (046): turning the key on keeps the paired session and leaves nothing readable on disk', async () => {
  const dir = folder();
  try {
    await plainSession(dir);
    await withKey(KEY, async () => {
      const auth = await useDurableAuthState(dir, await baileys(), quiet);
      assert.equal(auth.source, 'saved', 'a sessão em texto puro continua valendo');
      assert.equal(auth.state.creds.me?.id, ME);
      assert.equal(auth.sealed, 2, 'os dois arquivos antigos foram cifrados');
      await auth.saveCreds();
      await auth.state.keys.set({ 'pre-key': { '1': { private: Buffer.from('p'), public: Buffer.from('q') } } });
      for (const name of readdirSync(dir)) {
        const text = readFileSync(path.join(dir, name), 'utf8');
        assert.ok(isSealed(text), `${name} ficou em texto puro`);
        assert.ok(!text.includes(ME) && !text.includes('valor-secreto'), `${name} expõe dados`);
      }
      // Reabre (como depois de reiniciar): lê tudo de volta.
      const again = await useDurableAuthState(dir, await baileys(), quiet);
      assert.equal(again.state.creds.me?.id, ME);
      assert.equal(again.sealed, 0, 'nada mais a cifrar');
      assert.deepEqual((await again.state.keys.get('session', ['5511999990000.0']))['5511999990000.0'], { chave: 'valor-secreto' });
      assert.equal((await peekSessionJson<{ me?: { id?: string } }>(path.join(dir, 'creds.json')) as { me?: { id?: string } }).me?.id, ME);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crypto (046): a wrong or missing key stops with an error and never touches the good session', async () => {
  const dir = folder();
  try {
    await plainSession(dir);
    await withKey(KEY, async () => { await (await useDurableAuthState(dir, await baileys(), quiet)).saveCreds(); });
    const before = readdirSync(dir).sort().map(name => [name, readFileSync(path.join(dir, name), 'utf8')]);
    for (const key of [OTHER, undefined]) {
      await withKey(key, async () => {
        await assert.rejects(async () => useDurableAuthState(dir, await baileys(), quiet), SessionKeyError);
        assert.equal(await peekSessionJson(path.join(dir, 'creds.json')), 'locked');
        // "Há sessão pareada?" continua dizendo que sim: o sistema não trata a conta como nova.
        assert.equal(await new WhatsAppProvider({ ownerId: 'u1', sessionDir: dir }).hasPairedSession(), true);
      });
    }
    const after = readdirSync(dir).sort().map(name => [name, readFileSync(path.join(dir, name), 'utf8')]);
    assert.deepEqual(after, before, 'nenhum arquivo foi renomeado, apagado ou regravado (nada de creds.json.ilegivel-*)');
    // Com a chave de volta, a sessão está inteira.
    await withKey(KEY, async () => { assert.equal((await useDurableAuthState(dir, await baileys(), quiet)).state.creds.me?.id, ME); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crypto (046): without a key the session files stay exactly as Baileys writes them', async () => {
  const dir = folder();
  try {
    await plainSession(dir);
    await withKey(undefined, async () => {
      const auth = await useDurableAuthState(dir, await baileys(), quiet);
      assert.equal(auth.sealed, 0);
      await auth.saveCreds();
      assert.ok(readFileSync(path.join(dir, 'creds.json'), 'utf8').startsWith('{'), 'texto puro, como sempre');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
