import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WhatsAppManager, type ManagedProvider } from './whatsapp-manager';
import { WhatsAppProvider } from './whatsapp';
import { whatsappSessionDir, legacyWhatsappSessionDir } from './session-paths';

const A = 'cmubh0d9o004o3xzg1tb13n3s';
const B = 'cmucakbe400og3xcof3u5s7gg';

function base() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-manager-'));
  // A sessão global legada existe e não pode ser tocada pelo gerenciador.
  mkdirSync(legacyWhatsappSessionDir(dir), { recursive: true });
  writeFileSync(path.join(legacyWhatsappSessionDir(dir), 'creds.json'), '{"me":{"id":"legado@s.whatsapp.net"}}');
  return dir;
}
const legacyUntouched = (dir: string) => {
  const creds = path.join(legacyWhatsappSessionDir(dir), 'creds.json');
  assert.ok(existsSync(creds), 'a pasta legada continua existindo');
  assert.equal(readFileSync(creds, 'utf8'), '{"me":{"id":"legado@s.whatsapp.net"}}', 'a sessão legada não foi alterada');
};

// Duble de provider: registra o que foi chamado, sem abrir socket nem tocar em arquivos.
function fakeProvider(ownerId: string, sessionDir: string, behaviour: { paired?: boolean; failConnect?: string } = {}) {
  const calls: string[] = [];
  const state = { state: 'disconnected' as string, qr: undefined as string | undefined, accountJid: undefined as string | undefined, error: undefined as string | undefined };
  const provider: ManagedProvider & { calls: string[]; state: typeof state } = {
    ownerId, sessionDir, calls, state,
    status: () => ({ ...state }),
    hasPairedSession: async () => behaviour.paired ?? false,
    connect: async () => { calls.push('connect'); if (behaviour.failConnect) throw new Error(behaviour.failConnect); state.state = 'connected'; state.accountJid = `55${ownerId.slice(-4)}@s.whatsapp.net`; return { ...state }; },
    disconnect: async () => { calls.push('disconnect'); state.state = 'disconnected'; return { ...state }; },
    stop: async () => { calls.push('stop'); },
    sync: async () => { calls.push('sync'); return { count: 0 }; },
    send: async () => ({ messageId: 'duble', context: '' }),
    flushReads: async () => undefined,
    flushDeliveryEvents: async () => undefined,
  };
  return provider;
}
const managerWithFakes = (dir: string, behaviour: Record<string, { paired?: boolean; failConnect?: string }> = {}) => {
  const created = new Map<string, ReturnType<typeof fakeProvider>>();
  const manager = new WhatsAppManager({
    sessionsBase: dir,
    createProvider: (ownerId, sessionDir) => {
      const provider = fakeProvider(ownerId, sessionDir, behaviour[ownerId] ?? {});
      created.set(ownerId, provider);
      return provider;
    },
  });
  return { manager, created };
};

test('manager: one provider per user, always the same instance, each with its own folder', () => {
  const dir = base();
  try {
    const { manager } = managerWithFakes(dir);
    const first = manager.for(A);
    assert.equal(manager.for(A), first, 'for(A) duas vezes: mesma instância');
    const other = manager.for(B);
    assert.notEqual(other, first, 'usuários diferentes: instâncias diferentes');
    assert.equal(first.sessionDir, whatsappSessionDir(A, dir));
    assert.equal(other.sessionDir, whatsappSessionDir(B, dir));
    assert.notEqual(first.sessionDir, other.sessionDir);
    assert.equal(first.ownerId, A);
    assert.equal(other.ownerId, B);
    // Nenhuma pasta de usuário cai dentro da legada, e a legada nunca é usada.
    for (const provider of [first, other]) assert.ok(!provider.sessionDir.startsWith(legacyWhatsappSessionDir(dir)));
    assert.deepEqual(manager.owners().sort(), [A, B].sort());
    assert.equal(manager.peek('cmuoutroidqualquer00000000'), undefined, 'peek não cria');
    assert.throws(() => manager.for('../fora'), /inválido/, 'id inválido não vira pasta');
    legacyUntouched(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manager: memory state of one connection never leaks into another', async () => {
  const dir = base();
  try {
    // Providers reais (sem conectar): o que importa é que cada instância tem o seu estado.
    const a = new WhatsAppProvider({ ownerId: A, sessionDir: whatsappSessionDir(A, dir) });
    const b = new WhatsAppProvider({ ownerId: B, sessionDir: whatsappSessionDir(B, dir) });
    const campos = ['socket', 'timer', 'generation', 'retries', 'wanted', 'starting', 'version', 'receiptWrites', 'credsSaving', 'authDir', 'data', 'serverEvents', 'deliveredSeen'];
    const interno = (p: WhatsAppProvider, campo: string) => (p as unknown as Record<string, unknown>)[campo];
    for (const campo of campos) {
      const [x, y] = [interno(a, campo), interno(b, campo)];
      if (x && typeof x === 'object') assert.notEqual(x, y, `${campo}: cada provider tem o seu`);
    }
    // QR, estado, número e erro de A não aparecem em B.
    Object.assign(a as unknown as { data: object }, { data: { state: 'qr', qr: 'data:image/png;base64,AAA', accountJid: '5511@s.whatsapp.net', error: 'erro de A' } });
    assert.equal(a.status().qr, 'data:image/png;base64,AAA');
    assert.deepEqual(b.status(), { state: 'disconnected' }, 'B continua limpo');
    assert.equal(b.status().qr, undefined);
    assert.equal(b.status().accountJid, undefined);
    assert.equal(b.status().error, undefined);
    // Timers e geração também são independentes.
    Object.assign(a as unknown as { generation: number; retries: number }, { generation: 7, retries: 3 });
    assert.equal(interno(b, 'generation'), 0);
    assert.equal(interno(b, 'retries'), 0);
    assert.equal(await b.hasPairedSession(), false, 'B não enxerga a sessão de A nem a legada');
    legacyUntouched(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manager: stopping one connection keeps the others running and preserves the session files', async () => {
  const dir = base();
  try {
    const { manager, created } = managerWithFakes(dir);
    manager.for(A); manager.for(B);
    // Sessões gravadas em disco, como o Baileys faria.
    for (const id of [A, B]) {
      mkdirSync(whatsappSessionDir(id, dir), { recursive: true });
      writeFileSync(path.join(whatsappSessionDir(id, dir), 'creds.json'), `{"me":{"id":"${id}"}}`);
    }
    await manager.stop(A);
    assert.deepEqual(created.get(A)!.calls, ['stop']);
    assert.deepEqual(created.get(B)!.calls, [], 'parar A não mexe em B');
    assert.deepEqual(manager.owners(), [B]);
    await manager.stopAll();
    assert.deepEqual(created.get(B)!.calls, ['stop']);
    assert.deepEqual(manager.owners(), []);
    // stop NUNCA faz logout nem apaga credenciais.
    for (const id of [A, B]) assert.ok(existsSync(path.join(whatsappSessionDir(id, dir), 'creds.json')), `sessão de ${id} preservada`);
    for (const id of [A, B]) assert.ok(!created.get(id)!.calls.includes('disconnect'));
    legacyUntouched(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manager: a connection failure of one user does not stop the others', async () => {
  const dir = base();
  try {
    const { manager, created } = managerWithFakes(dir, { [A]: { paired: true, failConnect: 'rede fora do ar' }, [B]: { paired: true } });
    const a = manager.for(A);
    const b = manager.for(B);
    await assert.rejects(a.connect(), /rede fora do ar/);
    await b.connect();
    assert.equal(b.status().state, 'connected', 'B conecta mesmo com A falhando');
    assert.equal(a.status().state, 'disconnected');
    assert.deepEqual(created.get(A)!.calls, ['connect']);
    legacyUntouched(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manager: the shared protocol version cache never shares anything else', async () => {
  const { sharedProtocolVersion, forgetProtocolVersion } = await import('./whatsapp.js');
  forgetProtocolVersion();
  let consultas = 0;
  const fetchVersion = async () => { consultas++; return { version: [2, 3000, 123] as [number, number, number], isLatest: true }; };
  assert.deepEqual(await sharedProtocolVersion(fetchVersion), [2, 3000, 123]);
  await sharedProtocolVersion(fetchVersion);
  assert.equal(consultas, 1, 'a versão é consultada uma vez para todos os providers');
  forgetProtocolVersion();
  await sharedProtocolVersion(fetchVersion);
  assert.equal(consultas, 2, 'depois de esquecer, consulta de novo');
  // Falha não fica em cache.
  forgetProtocolVersion();
  await assert.rejects(sharedProtocolVersion(async () => { throw new Error('sem internet'); }), /sem internet/);
  assert.deepEqual(await sharedProtocolVersion(fetchVersion), [2, 3000, 123]);
});
