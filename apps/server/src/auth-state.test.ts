import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useDurableAuthState, writeAtomic } from './auth-state';
import { LOCK_STALE_MS, SessionLock, lockHeld } from './session-lock';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const baileys = () => import('@whiskeysockets/baileys');
const folder = () => mkdtempSync(path.join(tmpdir(), 'wa-auth-'));
const quiet = () => undefined;

// Uma sessão "pareada" no formato do Baileys: creds com me.id.
async function pairedCreds() {
  const { initAuthCreds, BufferJSON } = await baileys();
  const creds = { ...initAuthCreds(), me: { id: '5511999990000:7@s.whatsapp.net', name: 'Teste' } };
  return { creds, text: JSON.stringify(creds, BufferJSON.replacer) };
}

test('auth (036): a session saved by Baileys loads as it is, keys included (no migration)', async () => {
  const dir = folder();
  try {
    const { text } = await pairedCreds();
    writeFileSync(path.join(dir, 'creds.json'), text); // exatamente como o useMultiFileAuthState grava
    writeFileSync(path.join(dir, 'session-5511999990000.0.json'), JSON.stringify({ chave: 'valor' }));
    const auth = await useDurableAuthState(dir, await baileys(), quiet);
    assert.equal(auth.source, 'saved');
    assert.equal(auth.state.creds.me?.id, '5511999990000:7@s.whatsapp.net');
    assert.deepEqual((await auth.state.keys.get('session', ['5511999990000.0']))['5511999990000.0'], { chave: 'valor' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth (036): a damaged creds.json comes back from the backup instead of becoming a new identity', async () => {
  const dir = folder();
  try {
    const { text } = await pairedCreds();
    const first = await useDurableAuthState(dir, await baileys(), quiet);
    writeFileSync(path.join(dir, 'creds.json'), text);
    // Grava pelo caminho novo: cria a cópia de segurança.
    const saved = await useDurableAuthState(dir, await baileys(), quiet);
    await saved.saveCreds();
    assert.ok(existsSync(path.join(dir, 'creds.json.bak')));
    assert.equal(first.source, 'new');
    // Processo morto no meio de uma gravação antiga: arquivo pela metade.
    writeFileSync(path.join(dir, 'creds.json'), text.slice(0, 40));
    const logs: string[] = [];
    const restored = await useDurableAuthState(dir, await baileys(), message => logs.push(message));
    assert.equal(restored.source, 'backup');
    assert.equal(restored.state.creds.me?.id, '5511999990000:7@s.whatsapp.net', 'mesma identidade: não pede QR');
    assert.match(logs.join('\n'), /restaurada da cópia/);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(dir, 'creds.json'), 'utf8')), 'o principal foi regravado inteiro');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth (036): unreadable and without backup, the file is kept aside, never silently overwritten', async () => {
  const dir = folder();
  try {
    writeFileSync(path.join(dir, 'creds.json'), '{"noiseKey": {"private": ');
    const auth = await useDurableAuthState(dir, await baileys(), quiet);
    assert.equal(auth.source, 'unreadable');
    assert.equal(auth.state.creds.me, undefined, 'começa do zero: vai pedir QR');
    const kept = readdirSync(dir).filter(name => name.startsWith('creds.json.ilegivel-'));
    assert.equal(kept.length, 1, 'o arquivo ilegível foi guardado para diagnóstico');
    assert.equal(readFileSync(path.join(dir, kept[0]), 'utf8'), '{"noiseKey": {"private": ');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth (036): writes are whole or nothing, leave no temporary files, and keys can be removed', async () => {
  const dir = folder();
  try {
    const auth = await useDurableAuthState(dir, await baileys(), quiet);
    await auth.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('a'), private: Buffer.from('b') }, '2': { public: Buffer.from('c'), private: Buffer.from('d') } } });
    const read = await auth.state.keys.get('pre-key', ['1', '2']);
    assert.ok(Buffer.from(read['1'].public).equals(Buffer.from('a')), 'Buffer volta como Buffer');
    await auth.state.keys.set({ 'pre-key': { '1': null } });
    assert.equal((await auth.state.keys.get('pre-key', ['1']))['1'], null);
    // Muitas gravações do mesmo arquivo ao mesmo tempo: a última vence e o arquivo é JSON válido.
    const target = path.join(dir, 'concorrente.json');
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeAtomic(target, JSON.stringify({ i, dado: 'x'.repeat(5000) }))));
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).i, 29, 'última chamada vence, não o último rename a terminar');
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'nenhum temporário sobrando');
    // Uma gravação que falha deve liberar sua trava, não envenenar as seguintes.
    const missingFolder = path.join(dir, 'criada-depois');
    const failedTarget = path.join(missingFolder, 'chave.json');
    await assert.rejects(writeAtomic(failedTarget, '{}'), { code: 'ENOENT' });
    mkdirSync(missingFolder);
    await writeAtomic(failedTarget, '{"ok":true}');
    assert.deepEqual(JSON.parse(readFileSync(failedTarget, 'utf8')), { ok: true });
    assert.deepEqual(readdirSync(missingFolder), ['chave.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── Trava da pasta de sessão (session-lock.ts, portado da sessão paralela) ───
test('session lock: a live process on this computer or a fresh one elsewhere holds it', () => {
  const now = 1_000_000;
  const self = { pid: 10, host: 'pc' };
  assert.equal(lockHeld({ pid: 10, host: 'pc', at: now }, now, self), false, 'a própria trava');
  assert.equal(lockHeld({ pid: 11, host: 'pc', at: now }, now, self, () => true), true, 'outro processo vivo');
  assert.equal(lockHeld({ pid: 11, host: 'pc', at: now }, now, self, () => false), false, 'processo morto não segura');
  assert.equal(lockHeld({ pid: 11, host: 'outro', at: now - 1000 }, now, self), true, 'outro computador, sinal recente');
  assert.equal(lockHeld({ pid: 11, host: 'outro', at: now - LOCK_STALE_MS - 1 }, now, self), false, 'sinal velho');
});

test('session lock refuses a second live owner and frees on release', async () => {
  const dir = folder();
  try {
    const file = path.join(dir, 'whatsapp.lock');
    const lock = new SessionLock(file);
    assert.deepEqual(await lock.acquire(), { ok: true });
    assert.deepEqual(await lock.acquire(), { ok: true }, 'renovar a própria trava');
    await lock.release();
    assert.equal(existsSync(file), false);
    // Trava de outro computador com sinal recente: recusa e diz quem é o dono.
    writeFileSync(file, JSON.stringify({ pid: 1, host: `${hostname()}-outro`, at: Date.now() }));
    const refused = await new SessionLock(file).acquire();
    assert.equal(refused.ok, false);
    await new SessionLock(file).release();
    assert.ok(readFileSync(file, 'utf8'), 'nunca solta a trava de outro processo');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('session lock is exclusive across two processes starting together', { timeout: 10_000 }, async () => {
  const dir = folder();
  const file = path.join(dir, 'whatsapp.lock');
  const program = `
    const { SessionLock } = require(process.argv[1]);
    const lock = new SessionLock(process.argv[2]);
    process.send('ready');
    process.on('message', async message => {
      if (message === 'go') {
        try { process.send((await lock.acquire()).ok ? 'acquired' : 'blocked'); }
        catch (error) { process.send('error:' + error.message); }
      }
      if (message === 'stop') { await lock.release(); process.exit(0); }
    });
  `;
  const children = Array.from({ length: 2 }, () => spawn(
    process.execPath,
    ['-e', program, path.join(__dirname, 'session-lock.js'), file],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  ));
  try {
    await Promise.all(children.map(child => once(child, 'message')));
    const outcomes = children.map(child => once(child, 'message').then(([value]) => value));
    for (const child of children) child.send('go');
    assert.deepEqual((await Promise.all(outcomes)).sort(), ['acquired', 'blocked']);
  } finally {
    const exits = children.map(child => once(child, 'exit').catch(() => child.kill()));
    for (const child of children) child.send('stop');
    await Promise.all(exits);
    rmSync(dir, { recursive: true, force: true });
  }
});
