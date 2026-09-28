import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useDurableAuthState, writeAtomic } from './auth-state';

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
    assert.doesNotThrow(() => JSON.parse(readFileSync(target, 'utf8')));
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'nenhum temporário sobrando');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
