import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, applyServerEvent, lockCampaign, LOCKING_TRANSACTION, acquireLease, renewLease, releaseLease, claimDelivery, finishDelivery, resumeAt, recordRead, currentTime, persistRead, flushPendingReads } from '@campaign/database';
import { buildApp } from './app';
import { hashPassword, requireSuperAdmin, bootstrapAdmin, SESSION_MAX_AGE_MS } from './auth';
import { startDispatcher, type SendingProvider } from './dispatcher';
import { staticRouter, createSendingRouter } from './sending-router';
import { migrateLegacySession, rollbackLegacySession, migrationRecordPath } from './session-migration';
import { legacySessionOwnerId } from './legacy-session';
import { whatsappSessionDir } from './session-paths';
import { WhatsAppManager, type ManagedProvider } from './whatsapp-manager';
import { loadConfig, TRUSTED_PROXIES } from './config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { videoFixture } from './media-fixture';
import { validateMedia, IMAGE_LIMIT, VIDEO_LIMIT } from './media';

const database = process.env.CAMPAIGN_TEST_DATABASE;
if (!database || !/^campaign_test_[a-f0-9]{16}$/.test(database) || new URL(process.env.DATABASE_URL!).pathname !== `/${database}`) throw Error('Testes só podem executar no banco descartável.');

// External clock fixtures are confined to this isolated test process/schema.
const originalFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (/^https:\/\/(www\.google\.com|www\.cloudflare\.com)\//.test(String(input))) return new Response(null, { status: 200, headers: { date: new Date().toUTCString() } });
  return originalFetch(input, init);
});
// Gerenciador da suíte com pasta TEMPORÁRIA: nenhum teste consegue criar sessão no caminho real.
const suiteSessions = mkdtempSync(join(tmpdir(), 'wa-suite-'));
const app = buildApp({
  status: () => ({ state: 'disconnected' }),
  connect: async () => ({ state: 'disconnected' }),
  disconnect: async () => ({ state: 'disconnected' }),
  sync: async () => ({ count: 0 }),
  hasPairedSession: async () => false,
}, loadConfig({}), new WhatsAppManager({
  sessionsBase: suiteSessions,
  createProvider: (ownerId, sessionDir) => ({
    ownerId, sessionDir,
    status: () => ({ state: 'disconnected' }),
    hasPairedSession: async () => false,
    connect: async () => ({ state: 'disconnected' }),
    disconnect: async () => ({ state: 'disconnected' }),
    stop: async () => undefined,
    sync: async () => ({ count: 0 }),
    send: async () => ({ messageId: 'duble', context: '' }),
    flushReads: async () => undefined,
    flushDeliveryEvents: async () => undefined,
  }),
}));
after(async () => { await app.close(); await prisma.$disconnect(); rmSync(suiteSessions, { recursive: true, force: true }); });
const apiPath = (url: string) => url.startsWith('/api/') ? url : `/api${url}`;
// Toda a API exige login: os testes entram uma vez pelo endpoint real e reutilizam o
// cookie, sempre com a origem do painel (exigida em ações que alteram dados).
const PANEL = 'http://localhost:3000';
let cookie = '';
// Dono dos dados que os testes criam direto no banco: o mesmo usuário logado (ADR-017).
let ownerId = '';
before(async () => {
  ownerId = (await prisma.user.create({ data: { email: 'dono@teste.local', name: 'Dono', passwordHash: await hashPassword('senha-de-teste-123') } })).id;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost', origin: PANEL }, payload: { email: 'dono@teste.local', password: 'senha-de-teste-123' } });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';')[0];
});
const auth = (extra: Record<string, string> = {}) => ({ host: 'localhost', origin: PANEL, cookie, ...extra });
const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url: apiPath(url), payload, headers: auth() });
async function create(count = 3) {
  const groups = await Promise.all(Array.from({ length: count }, (_, i) => prisma.group.create({ data: { name: `Teste ${i}`, userId: ownerId } })));
  const r = await request('POST', '/campaigns', { name: 'Fila de teste', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['teste'], groupIds: groups.map(g => g.id) });
  assert.equal(r.statusCode, 201, r.body); return { id: r.json().id as string, groups };
}
async function activate(id: string) { const r = await request('PATCH', `/campaigns/${id}/status`, { status: 'ACTIVE', provider: 'simulator' }); assert.equal(r.statusCode, 200, r.body); }
const deliveries = (id: string) => prisma.delivery.findMany({ where: { campaignId: id }, orderBy: { sequence: 'asc' } });

test('empty dashboard has no fabricated success or activity', async () => {
  const d = (await request('GET', '/dashboard')).json();
  assert.equal(d.successRate, null);
  assert.equal(d.sentToday, 0);
  assert.deepEqual(d.recentActivity, []);
});

for (const kind of ['image', 'video'] as const) test(`${kind}: persistent upload, preview, one delivery per group and safe pause/resume`, async () => {
  const { PrismaClient } = await import('@prisma/client');
  const bytes = kind === 'image' ? await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer() : videoFixture;
  const mimeType = kind === 'image' ? 'image/png' : 'video/mp4';
  const upload = await app.inject({ method: 'POST', url: '/api/media?name=test-file', headers: auth({ 'content-type': mimeType }), payload: bytes });
  assert.equal(upload.statusCode, 201, upload.body);
  const media = upload.json(); assert.equal(media.kind, kind); assert.equal(media.data, undefined);
  const { groups } = await create(2);
  const body = { name: 'Media fixture', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['caption'], groupIds: groups.map(g => g.id), mediaId: media.id };
  const created = await request('POST', '/campaigns', body); assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const preview = await app.inject({ method: 'GET', url: `/api/media/${media.id}`, headers: auth() });
  assert.equal(preview.statusCode, 200); assert.deepEqual(preview.rawPayload, bytes);
  const range = await app.inject({ method: 'GET', url: `/api/media/${media.id}`, headers: auth({ range: 'bytes=0-9' }) });
  assert.equal(range.statusCode, 206); assert.deepEqual(range.rawPayload, bytes.subarray(0, 10));
  assert.equal((await app.inject({ method: 'GET', url: `/api/media/${media.id}`, headers: auth({ range: 'bytes=999999-' }) })).statusCode, 416);
  // A new DB client represents a restarted backend; no local upload path is required.
  const fresh = new PrismaClient();
  try {
    const stored = await fresh.campaignMedia.findUniqueOrThrow({ where: { id: media.id } });
    assert.deepEqual(Buffer.from(stored.data), bytes);
    assert.equal((await fresh.campaign.findUniqueOrThrow({ where: { id } })).mediaId, media.id);
  } finally { await fresh.$disconnect(); }
  await activate(id); const rows = await deliveries(id); assert.equal(rows.length, 2);
  assert.equal((await request('PATCH', `/campaigns/${id}`, { ...body, mediaId: null })).statusCode, 400);
  const at = new Date(rows[0].scheduledAt.getTime() + 1);
  const claimed = await claimDelivery(prisma, rows[0].id, at);
  assert.equal(claimed?.campaign.mediaId, media.id);
  assert.equal(await claimDelivery(prisma, rows[0].id, at), null);
  await finishDelivery(prisma, rows[0].id, { providerId: 'sim-media' }, at);
  assert.equal((await request('PATCH', `/campaigns/${id}/status`, { status: 'PAUSED' })).statusCode, 200);
  assert.equal(await claimDelivery(prisma, rows[1].id, new Date(at.getTime() + 999999)), null);
  await activate(id);
  assert.equal((await request('GET', `/campaigns/${id}`)).json().media.id, media.id);
  assert.equal((await request('PATCH', `/campaigns/${id}/status`, { status: 'CANCELLED' })).statusCode, 200);
  assert.equal((await deliveries(id))[1].status, 'CANCELLED');
  assert.equal(await claimDelivery(prisma, rows[0].id, new Date(at.getTime() + 999999)), null);
});

test('media rejects malformed content, spoofed MIME, excessive size and multiple IDs; draft can remove media', async () => {
  await assert.rejects(validateMedia(Buffer.from('<script>bad</script>'), 'image/png'));
  await assert.rejects(validateMedia(Buffer.from('not an mp4'), 'video/mp4'));
  await assert.rejects(validateMedia(Buffer.alloc(IMAGE_LIMIT + 1), 'image/png'), /16 MB/);
  await assert.rejects(validateMedia(Buffer.alloc(VIDEO_LIMIT + 1), 'video/mp4'), /64 MB/);
  await assert.rejects(validateMedia(videoFixture, 'image/png'));
  const { id, groups } = await create(1);
  const body = { name: 'draft', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['text'], groupIds: groups.map(g => g.id) };
  assert.equal((await request('PATCH', `/campaigns/${id}`, { ...body, mediaId: ['a', 'b'] })).statusCode, 400);
  assert.equal((await request('PATCH', `/campaigns/${id}`, { ...body, mediaId: 'missing' })).statusCode, 400);
  assert.equal((await request('PATCH', `/campaigns/${id}`, { ...body, mediaId: null })).statusCode, 200);
  assert.equal((await request('GET', `/campaigns/${id}`)).json().media, null);
});

test('dashboard orders campaign heads by effective time and omits paused campaigns', async () => {
  await prisma.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });
  const a = await create(1); const b = await create(1);
  await activate(a.id); await activate(b.id);
  const base = Date.now() + 3600000;
  await prisma.delivery.updateMany({ where: { campaignId: a.id }, data: { scheduledAt: new Date(base) } });
  await prisma.delivery.updateMany({ where: { campaignId: b.id }, data: { scheduledAt: new Date(base + 60000) } });
  await prisma.campaign.update({ where: { id: a.id }, data: { nextAvailableAt: new Date(base + 180000) } });
  await prisma.campaign.update({ where: { id: b.id }, data: { nextAvailableAt: new Date(base + 120000) } });
  let dashboard = (await request('GET', '/dashboard')).json();
  assert.equal(dashboard.nextDelivery.campaignId, b.id);
  assert.equal(dashboard.nextDelivery.nextAt, new Date(base + 120000).toISOString());
  assert.equal(dashboard.runningCampaigns.find((c: { id: string }) => c.id === b.id).total, 1);
  await request('PATCH', `/campaigns/${b.id}/status`, { status: 'PAUSED' });
  dashboard = (await request('GET', '/dashboard')).json();
  assert.equal(dashboard.nextDelivery.campaignId, a.id);
  assert.ok(!dashboard.runningCampaigns.some((c: { id: string }) => c.id === b.id));
  assert.equal(dashboard.nextDelivery.nextAt, new Date(base + 180000).toISOString());
  await request('PATCH', `/campaigns/${a.id}/status`, { status: 'PAUSED' });
  assert.equal((await request('GET', '/dashboard')).json().nextDelivery, null);
});

test('draft editing preserves ID, replaces configuration, and rejects editing after activation', async () => {
  const { id, groups } = await create(2);
  const payload = { name: 'Editada', mode: 'IMMEDIATE', intervalSeconds: 60, messages: ['novo texto', 'segunda'], groupIds: groups.map(g => g.id).reverse() };
  const result = await request('PATCH', `/campaigns/${id}`, payload);
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().id, id);
  const detail = (await request('GET', `/campaigns/${id}`)).json();
  assert.equal(detail.name, 'Editada'); assert.equal(detail.intervalSeconds, 60);
  assert.deepEqual(detail.groups.map((g: { groupId: string }) => g.groupId), payload.groupIds);
  assert.deepEqual(detail.messages.map((m: { content: string }) => m.content), payload.messages);
  assert.equal((await deliveries(id)).length, 0);
  const expired = await request('PATCH', `/campaigns/${id}`, { ...payload, mode: 'SCHEDULED', startsAt: '2004-09-17', endsAt: '2004-09-17', times: ['09:00'] });
  assert.equal(expired.statusCode, 400);
  assert.equal((await request('GET', `/campaigns/${id}`)).json().mode, 'IMMEDIATE');
  await activate(id);
  assert.equal((await request('PATCH', `/campaigns/${id}`, { ...payload, name: 'Não salvar' })).statusCode, 400);
  assert.equal((await request('GET', `/campaigns/${id}`)).json().name, 'Editada');
  assert.equal((await deliveries(id)).length, 2);
});

test('3 groups: durable order, interval, duplicate claims, pause, resume, completion', async () => {
  const { id, groups } = await create(); await activate(id);
  const rows = await deliveries(id); assert.deepEqual(rows.map(r => r.groupId), groups.map(g => g.id));
  assert.equal(rows[2].scheduledAt.getTime() - rows[0].scheduledAt.getTime(), 360000);
  const at = new Date(rows[0].scheduledAt.getTime() + 10);
  const claims = await Promise.all([claimDelivery(prisma, rows[0].id, at), claimDelivery(prisma, rows[0].id, at)]);
  assert.equal(claims.filter(Boolean).length, 1);
  await finishDelivery(prisma, rows[0].id, { providerId: 'sim-one' }, at);
  assert.equal(await claimDelivery(prisma, rows[0].id, new Date(at.getTime() + 600000)), null);
  assert.equal(await claimDelivery(prisma, rows[1].id, new Date(at.getTime() + 179999)), null);
  assert.equal((await request('PATCH', `/campaigns/${id}/status`, { status: 'PAUSED' })).statusCode, 200);
  assert.equal(await claimDelivery(prisma, rows[1].id, new Date(at.getTime() + 999999)), null);
  assert.equal((await request('PATCH', `/campaigns/${id}/status`, { status: 'ACTIVE' })).statusCode, 200);
  assert.equal((await deliveries(id)).length, 3);
  const later = new Date(at.getTime() + 1000000);
  assert.ok(await claimDelivery(prisma, rows[1].id, later)); await finishDelivery(prisma, rows[1].id, { providerId: 'sim-two' }, later);
  assert.equal(await claimDelivery(prisma, rows[2].id, new Date(later.getTime() + 179999)), null);
  const last = new Date(later.getTime() + 180000);
  assert.ok(await claimDelivery(prisma, rows[2].id, last)); await finishDelivery(prisma, rows[2].id, { providerId: 'sim-three' }, last);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status, 'COMPLETED');
  assert.equal((await request('PATCH', `/campaigns/${id}/status`, { status: 'ACTIVE' })).statusCode, 400);
});
test('one group finishes automatically and refresh never creates more sends', async () => {
  const { id } = await create(1); await activate(id); const [row] = await deliveries(id);
  assert.ok(await claimDelivery(prisma, row.id, new Date(row.scheduledAt.getTime() + 1))); await finishDelivery(prisma, row.id, { providerId: 'one' });
  for (let i = 0; i < 3; i++) assert.equal((await request('GET', `/campaigns/${id}`)).json().status, 'COMPLETED');
  assert.equal((await deliveries(id)).length, 1);
});
test('stop cancels pending; soft delete preserves historical records and is idempotent', async () => {
  const { id } = await create(); await activate(id); const rows = await deliveries(id);
  assert.equal((await request('DELETE', `/campaigns/${id}`)).statusCode, 400);
  const at = new Date(rows[0].scheduledAt.getTime() + 1); assert.ok(await claimDelivery(prisma, rows[0].id, at));
  assert.equal((await request('PATCH', `/campaigns/${id}/status`, { status: 'CANCELLED' })).statusCode, 200);
  assert.equal((await request('DELETE', `/campaigns/${id}`)).statusCode, 400);
  await finishDelivery(prisma, rows[0].id, { providerId: 'already-in-flight' });
  assert.equal(await claimDelivery(prisma, rows[1].id, new Date(at.getTime() + 999999)), null);
  assert.equal((await request('DELETE', `/campaigns/${id}`)).statusCode, 200);
  assert.equal((await request('DELETE', `/campaigns/${id}`)).statusCode, 200);
  assert.equal((await deliveries(id)).length, 3);
  assert.equal((await request('GET', `/campaigns/${id}`)).statusCode, 404);
  assert.ok(!(await request('GET', '/campaigns')).json().some((c: {id: string}) => c.id === id));
});
test('uncertain failure never retries; next group continues after the interval', async () => {
  const { id } = await create(2); await activate(id); const rows = await deliveries(id); const at = new Date(rows[0].scheduledAt.getTime() + 1);
  await claimDelivery(prisma, rows[0].id, at); await finishDelivery(prisma, rows[0].id, { error: 'Resposta perdida; resultado incerto.' }, at);
  assert.equal(await claimDelivery(prisma, rows[0].id, new Date(at.getTime() + 200000)), null);
  assert.ok(await claimDelivery(prisma, rows[1].id, new Date(at.getTime() + 180000)));
  await finishDelivery(prisma, rows[1].id, { providerId: 'after-failure' });
  assert.equal((await request('GET', `/campaigns/${id}`)).json().progress.FAILED, 1);
});
test('restart preserves durable claim and pending order with a fresh database client', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { id } = await create(2); await activate(id); const rows = await deliveries(id); const at = new Date(rows[0].scheduledAt.getTime() + 1);
  await claimDelivery(prisma, rows[0].id, at);
  const fresh = new PrismaClient();
  try {
    assert.equal(await claimDelivery(fresh, rows[0].id, new Date(at.getTime() + 500000)), null);
    assert.equal(await claimDelivery(fresh, rows[1].id, new Date(at.getTime() + 500000)), null);
    await fresh.delivery.updateMany({ where: { campaignId: id, status: 'PROCESSING' }, data: { status: 'FAILED', error: 'Interrompido: resultado incerto.' } });
    assert.ok(await claimDelivery(fresh, rows[1].id, new Date(at.getTime() + 500000)));
    await finishDelivery(fresh, rows[1].id, { providerId: 'resumed' });
  } finally { await fresh.$disconnect(); }
});
test('invalid intervals rejected; 100 groups persist in selection order', async () => {
  for (const intervalSeconds of [0, -1, 59, 3601, 90.5, '180']) assert.equal((await request('POST', '/campaigns', { name: 'Invalid', intervalSeconds })).statusCode, 400);
  const { id, groups } = await create(100); await activate(id);
  assert.deepEqual((await deliveries(id)).map(r => r.groupId), groups.map(g => g.id));
});
test('receipt uniqueness survives duplicates and excludes simulations from sent metrics', async () => {
  const { id } = await create(1); await activate(id); const [row] = await deliveries(id);
  await prisma.delivery.update({ where: { id: row.id }, data: { provider: 'baileys', status: 'SENT', sentAt: new Date() } });
  const data = { deliveryId: row.id, recipientHash: 'pseudonymous-recipient', readAt: new Date() };
  await Promise.all([prisma.deliveryRead.createMany({ data: [data], skipDuplicates: true }), prisma.deliveryRead.createMany({ data: [data], skipDuplicates: true })]);
  assert.equal(await prisma.deliveryRead.count({ where: { deliveryId: row.id } }), 1);
  const dashboard = (await request('GET', '/dashboard')).json(); assert.equal(dashboard.sentToday, 1); assert.equal(dashboard.readsToday, 1);
});
test('pause preserves remaining interval rather than resending or bursting', () => {
  assert.equal(resumeAt(new Date(180000), new Date(60000), new Date(1000000)).getTime(), 1120000);
});
// Painel e API agora têm a mesma origem: não há CORS nem preflight. No lugar da checagem
// de preflight, uma regra mais forte: ação destrutiva sem Origin é recusada mesmo logado.
test('foreign origins rejected even on WhatsApp routes; destructive calls without Origin rejected even with a session', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/whatsapp/status', headers: auth({ origin: 'https://example.com' }) });
  assert.equal(r.statusCode, 403);
  const { origin: _omit, ...semOrigem } = auth();
  const del = await app.inject({ method: 'DELETE', url: '/api/campaigns/qualquer', headers: semOrigem });
  assert.equal(del.statusCode, 403);
});

test('read receipts are isolated by campaign, group and account, deduplicated and totalled without pagination', async () => {
  const a = await create(2); const b = await create(1);
  await activate(a.id); await activate(b.id);
  const accountJid = '5511999999999@s.whatsapp.net';
  await prisma.campaign.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { accountJid } });
  for (const g of [...a.groups, ...b.groups]) await prisma.group.update({ where: { id: g.id }, data: { externalId: `${g.id}@g.us` } });
  const rows = [...await deliveries(a.id), ...await deliveries(b.id)];
  for (const row of rows) await prisma.delivery.update({ where: { id: row.id }, data: { status: 'SENT', provider: 'baileys', providerId: 'same-id-in-different-groups', sentAt: await currentTime() } });
  const receipt = { messageId: 'same-id-in-different-groups', groupJid: `${a.groups[0].id}@g.us`, accountJid, participant: 'reader@s.whatsapp.net', readAt: await currentTime() };
  assert.equal(await recordRead(prisma, { ...receipt, accountJid: 'wrong-account' }), false);
  assert.equal(await recordRead(prisma, { ...receipt, groupJid: 'missing@g.us' }), false);
  await Promise.all([recordRead(prisma, receipt), recordRead(prisma, receipt)]);
  await recordRead(prisma, { ...receipt, groupJid: `${a.groups[1].id}@g.us` });
  await recordRead(prisma, { ...receipt, groupJid: `${b.groups[0].id}@g.us` });
  let detail = (await request('GET', `/campaigns/${a.id}`)).json();
  assert.equal(detail.readsTotal, 2); assert.deepEqual(detail.readsByGroup.map((g: { count: number }) => g.count), [1, 1]);
  assert.equal((await request('GET', `/campaigns/${b.id}`)).json().readsTotal, 1);
  // A second message read by the same person is another read, not another unique person.
  const extra = await prisma.delivery.create({ data: { campaignId: a.id, groupId: a.groups[0].id, messageBody: 'fixture', provider: 'baileys', providerId: 'second-message', status: 'PROCESSING', sequence: 2, scheduledAt: new Date(receipt.readAt.getTime() + 1000) } });
  assert.equal(await recordRead(prisma, { ...receipt, messageId: 'second-message' }), false);
  await prisma.delivery.update({ where: { id: extra.id }, data: { status: 'SENT' } });
  assert.equal(await recordRead(prisma, { ...receipt, messageId: 'second-message' }), true);
  detail = (await request('GET', `/campaigns/${a.id}`)).json();
  assert.equal(detail.readsTotal, 3); assert.deepEqual(detail.readsByGroup.map((g: { count: number }) => g.count), [2, 1]);
  const bulk = Array.from({ length: 101 }, (_, i) => ({ id: `read-fixture-${a.id}-${i}`, campaignId: a.id, groupId: a.groups[0].id, messageBody: 'fixture', provider: 'baileys', status: 'SENT' as const, sequence: i + 3, scheduledAt: new Date(receipt.readAt.getTime() + (i + 2) * 1000) }));
  await prisma.delivery.createMany({ data: bulk });
  await prisma.deliveryRead.createMany({ data: bulk.map(d => ({ deliveryId: d.id, recipientHash: 'isolated-test-recipient', readAt: receipt.readAt })) });
  detail = (await request('GET', `/campaigns/${a.id}`)).json();
  assert.equal(detail.readsTotal, 104); assert.equal(detail.readsByGroup[0].count, 103);
  // A repeated provider ID within the same account/group is ambiguous: never guess.
  await prisma.delivery.update({ where: { id: extra.id }, data: { providerId: receipt.messageId } });
  assert.equal(await recordRead(prisma, { ...receipt, participant: 'another-reader@s.whatsapp.net' }), false);
});

test('pending receipts survive a new client, early arrival and replay after recording', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { id, groups } = await create(1); await activate(id);
  const [delivery] = await deliveries(id);
  const accountJid = 'durable-account'; const groupJid = `${groups[0].id}@g.us`;
  await prisma.campaign.update({ where: { id }, data: { accountJid } });
  await prisma.group.update({ where: { id: groups[0].id }, data: { externalId: groupJid } });
  const receipt = { accountJid, groupJid, messageId: `durable-${id}`, participant: 'reader', readAt: new Date() };
  await Promise.all([persistRead(prisma, receipt), persistRead(prisma, receipt)]);
  assert.equal(await prisma.pendingRead.count({ where: { messageId: receipt.messageId } }), 1);
  await flushPendingReads(prisma);
  assert.equal(await prisma.pendingRead.count({ where: { messageId: receipt.messageId } }), 1);
  const fresh = new PrismaClient();
  try {
    await fresh.delivery.update({ where: { id: delivery.id }, data: { provider: 'baileys', providerId: receipt.messageId, status: 'SENT' } });
    await fresh.pendingRead.updateMany({ where: { messageId: receipt.messageId }, data: { nextAttemptAt: new Date(0) } });
    // Simulate interruption between recording the read and deleting its inbox row.
    await recordRead(fresh, receipt);
    await flushPendingReads(fresh);
    assert.equal(await fresh.pendingRead.count({ where: { messageId: receipt.messageId } }), 0);
    await persistRead(fresh, receipt); await flushPendingReads(fresh);
    assert.equal(await fresh.deliveryRead.count({ where: { deliveryId: delivery.id } }), 1);
  } finally { await fresh.$disconnect(); }
});

test('closed campaign retains old group reads while dashboard success uses today only', async () => {
  const old = new Date('2020-01-01T12:00:00Z');
  // Isolated schema: remove earlier fixtures from today's terminal-result window.
  await prisma.delivery.updateMany({ where: { status: { in: ['SENT', 'FAILED'] } }, data: { sentAt: old, updatedAt: old } });
  const { id, groups } = await create(2); await activate(id);
  const rows = await deliveries(id);
  for (const row of rows) await prisma.delivery.update({ where: { id: row.id }, data: { status: 'SENT', provider: 'baileys', sentAt: old, updatedAt: old } });
  await prisma.deliveryRead.createMany({ data: rows.map((row, i) => ({ deliveryId: row.id, recipientHash: `historical-${i}`, readAt: old })) });
  await prisma.campaign.update({ where: { id }, data: { status: 'COMPLETED' } });
  const detail = (await request('GET', `/campaigns/${id}`)).json();
  assert.equal(detail.readsTotal, 2);
  assert.deepEqual(detail.readsByGroup.map((g: { count: number }) => g.count), [1, 1]);
  let dashboard = (await request('GET', '/dashboard')).json();
  assert.equal(dashboard.successRate, null);
  assert.ok(!dashboard.runningCampaigns.some((c: { id: string }) => c.id === id));
  const now = await currentTime();
  await prisma.delivery.update({ where: { id: rows[0].id }, data: { sentAt: now, updatedAt: now } });
  await prisma.delivery.update({ where: { id: rows[1].id }, data: { status: 'FAILED', sentAt: null, updatedAt: now } });
  dashboard = (await request('GET', '/dashboard')).json();
  assert.equal(dashboard.sentToday, 1); assert.equal(dashboard.failedToday, 1); assert.equal(dashboard.successRate, 50);
  assert.ok(dashboard.recentActivity.some((e: { id: string; status: string }) => e.id === rows[0].id && e.status === 'SENT'));
  assert.ok(dashboard.recentActivity.some((e: { id: string; status: string }) => e.id === rows[1].id && e.status === 'FAILED'));
  assert.ok(dashboard.recentActivity.length <= 8);
});

test('server time remains authoritative with a wrong client time and timezone', async () => {
  const r = await request('GET', '/time');
  assert.equal(r.statusCode, 200); assert.equal(r.json().timezone, 'America/Sao_Paulo');
  assert.ok(Number.isFinite(Date.parse(r.json().now)));
  const { id } = await create(1);
  const detail = (await request('GET', `/campaigns/${id}`)).json();
  assert.ok(Number.isFinite(Date.parse(detail.serverNow)));
});

test('groups with zero reads remain visible and disconnected activation creates no deliveries', async () => {
  const { id } = await create(2);
  const detail = (await request('GET', `/campaigns/${id}`)).json();
  assert.deepEqual(detail.readsByGroup.map((g: { count: number }) => g.count), [0, 0]);
  assert.equal(detail.readsTotal, 0);
  {
    const result = await request('PATCH', `/campaigns/${id}/status`, { status: 'ACTIVE', provider: 'baileys', consent: true });
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /Conecte o WhatsApp/);
    assert.equal((await deliveries(id)).length, 0);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status, 'DRAFT');
  }
});

// Regressão: a comparação do vencimento não pode depender do fuso da sessão do
// Postgres. Com SQL bruto, um lease vencido só era reconhecido 3 h depois (UTC-3),
// e um worker morto bloqueava o sistema. Aqui o vencimento é de apenas 31 s.
test('worker lease: exclusive while live, taken over 31 seconds after expiry, released only by its owner', async () => {
  const ttl = 30_000;
  const t0 = new Date();
  assert.equal(await acquireLease(prisma, 'A', ttl, t0), true, 'primeiro processo toma a posse');
  assert.equal(await acquireLease(prisma, 'B', ttl, t0), false, 'segundo é recusado enquanto A está vivo');
  assert.equal(await acquireLease(prisma, 'B', ttl, new Date(t0.getTime() + 29_000)), false, 'ainda dentro do TTL');
  assert.equal(await renewLease(prisma, 'A', ttl, new Date(t0.getTime() + 10_000)), true, 'A renova');
  assert.equal(await renewLease(prisma, 'B', ttl, t0), false, 'quem não é dono não renova');

  // A parou de renovar em t0+10s (expira em t0+40s). Em t0+41s deve ser assumível.
  assert.equal(await acquireLease(prisma, 'B', ttl, new Date(t0.getTime() + 41_000)), true, 'lease vencido há 1 s é assumido, não 3 h depois');
  assert.equal(await renewLease(prisma, 'A', ttl, new Date(t0.getTime() + 42_000)), false, 'A perdeu a posse');

  await releaseLease(prisma, 'A'); // não é o dono: não pode liberar
  assert.equal(await acquireLease(prisma, 'A', ttl, new Date(t0.getTime() + 43_000)), false, 'release de não-dono não libera');
  await releaseLease(prisma, 'B');
  assert.equal(await acquireLease(prisma, 'A', ttl, new Date(t0.getTime() + 44_000)), true, 'após release do dono, livre');
  await releaseLease(prisma, 'A');
});

// Regressão MySQL: o InnoDB usa REPEATABLE READ e congela o snapshot na primeira leitura
// da transação, que em claimDelivery acontece antes do lock da campanha. Sem READ
// COMMITTED, uma pausa confirmada durante a espera pelo lock ficava invisível e a
// entrega saía com a campanha pausada.
test('claim waiting on the campaign lock sees a pause committed meanwhile (never sends while paused)', async () => {
  const { id } = await create(2); await activate(id);
  const [head] = await deliveries(id);
  const at = new Date(head.scheduledAt.getTime() + 10);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let locked!: () => void;
  const hasLock = new Promise<void>(resolve => { locked = resolve; });
  const pausing = prisma.$transaction(async tx => {
    await lockCampaign(tx, id);
    await tx.campaign.update({ where: { id }, data: { status: 'PAUSED', pausedAt: at } });
    locked();
    await gate;
  }, { ...LOCKING_TRANSACTION, timeout: 20000 });
  await hasLock;
  const claim = claimDelivery(prisma, head.id, at);   // lê a entrega e fica esperando o lock
  await new Promise(resolve => setTimeout(resolve, 400));
  release();
  await pausing;
  assert.equal(await claim, null, 'a reserva tem que enxergar a pausa confirmada');
  assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { id: head.id } })).status, 'PENDING');
});

test('health reports the database, text columns keep long content and accents intact', async () => {
  const health = await request('GET', '/health');
  assert.equal(health.statusCode, 200, health.body);
  assert.deepEqual(health.json(), { status: 'ok', database: 'ok' });

  const longMessage = 'Olá, ação! 🎉 ' + 'x'.repeat(9_980);
  const group = await prisma.group.create({ data: { name: 'São João — Coração 💚', userId: ownerId } });
  const r = await request('POST', '/campaigns', { name: 'Ç'.repeat(200), mode: 'IMMEDIATE', intervalSeconds: 60, messages: [longMessage], groupIds: [group.id] });
  assert.equal(r.statusCode, 201, r.body);
  const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: r.json().id }, include: { messages: true } });
  assert.equal(saved.name, 'Ç'.repeat(200));
  assert.equal(saved.messages[0].content, longMessage);
  assert.equal((await prisma.group.findUniqueOrThrow({ where: { id: group.id } })).name, 'São João — Coração 💚');

  const tooLong = await request('POST', '/groups', { name: 'a'.repeat(256) });
  assert.equal(tooLong.statusCode, 400);
});

// ─── Login e proteção da API ────────────────────────────────────────────────────
const fakeProvider = { status: () => ({ state: 'qr', qr: 'data:image/png;base64,SEGREDO' }), connect: async () => ({ state: 'qr' }), disconnect: async () => ({ state: 'disconnected' }), sync: async () => ({ count: 0 }), hasPairedSession: async () => false };
const anon = { host: 'localhost', origin: PANEL };

test('every API route denies access without a session, including the QR code', async () => {
  const guarded = [
    ['GET', '/api/groups'], ['POST', '/api/groups'], ['GET', '/api/campaigns'], ['POST', '/api/campaigns'],
    ['GET', '/api/campaigns/x'], ['PATCH', '/api/campaigns/x'], ['PATCH', '/api/campaigns/x/status'], ['DELETE', '/api/campaigns/x'],
    ['GET', '/api/deliveries'], ['GET', '/api/dashboard'], ['GET', '/api/time'], ['POST', '/api/media'], ['GET', '/api/media/x'],
    ['GET', '/api/whatsapp/status'], ['POST', '/api/whatsapp/connect'], ['POST', '/api/whatsapp/disconnect'], ['POST', '/api/whatsapp/sync'],
    ['GET', '/api/auth/me'], ['POST', '/api/auth/password'], ['GET', '/api/rota-que-ainda-nao-existe'],
  ] as const;
  const probe = buildApp(fakeProvider);
  try {
    for (const [method, url] of guarded) {
      const r = await probe.inject({ method, url, headers: anon, payload: method === 'GET' ? undefined : {} });
      assert.equal(r.statusCode, 401, `${method} ${url} respondeu ${r.statusCode}`);
      assert.doesNotMatch(r.body, /SEGREDO/, `${method} ${url} vazou o QR`);
    }
    assert.equal((await probe.inject({ method: 'GET', url: '/api/health', headers: anon })).statusCode, 200);
  } finally { await probe.close(); }
});

test('login sets a hardened cookie, logout and expiry end the session, wrong passwords are rate limited', async () => {
  await prisma.user.create({ data: { email: 'operador@teste.local', name: 'Operador', passwordHash: await hashPassword('outra-senha-forte-1') } });
  const probe = buildApp(fakeProvider);
  const login = (password: string, email = 'OPERADOR@teste.local ') => probe.inject({ method: 'POST', url: '/api/auth/login', headers: anon, payload: { email, password } });
  try {
    assert.equal((await login('errada-0000')).statusCode, 401);
    const ok = await login('outra-senha-forte-1');
    assert.equal(ok.statusCode, 200, ok.body);
    const set = String(ok.headers['set-cookie']);
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert.match(set, new RegExp(flag));
    assert.doesNotMatch(set, /Secure/, 'localhost em http não usa Secure');
    const session = set.split(';')[0];
    const stored = await prisma.authSession.findMany({ where: { user: { email: 'operador@teste.local' } } });
    assert.equal(stored.length, 1);
    assert.ok(!set.includes(stored[0].tokenHash), 'o banco guarda só o hash do token');
    const me = await probe.inject({ method: 'GET', url: '/api/auth/me', headers: { ...anon, cookie: session } });
    assert.equal(me.json().user.email, 'operador@teste.local');

    await prisma.authSession.update({ where: { id: stored[0].id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: { ...anon, cookie: session } })).statusCode, 401, 'sessão vencida');

    const again = String((await login('outra-senha-forte-1')).headers['set-cookie']).split(';')[0];
    assert.equal((await probe.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...anon, cookie: again } })).statusCode, 200);
    assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: { ...anon, cookie: again } })).statusCode, 401, 'logout encerra');

    for (let i = 0; i < 10; i++) await login('errada-' + i, 'alvo@teste.local');
    const blocked = await login('qualquer', 'alvo@teste.local');
    assert.equal(blocked.statusCode, 429);
    assert.match(blocked.json().error, /Aguarde/);
  } finally { await probe.close(); }
});

test('published URL: secure cookie, only its host and origin accepted, security headers on every response', async () => {
  const config = loadConfig({ PUBLIC_URL: 'https://campanhas.exemplo.com.br', PORT: '8080' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.trustProxy, TRUSTED_PROXIES, 'só proxies da rede interna, nunca o cabeçalho do cliente');
  const probe = buildApp(fakeProvider, config);
  const site = { host: 'campanhas.exemplo.com.br', origin: 'https://campanhas.exemplo.com.br' };
  try {
    const ok = await probe.inject({ method: 'POST', url: '/api/auth/login', headers: site, payload: { email: 'dono@teste.local', password: 'senha-de-teste-123' } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(String(ok.headers['set-cookie']), /Secure/);
    assert.match(String(ok.headers['strict-transport-security']), /max-age/);
    assert.match(String(ok.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal((await probe.inject({ method: 'GET', url: '/api/health', headers: { host: 'nome-interno-do-proxy' } })).statusCode, 200, 'publicado, o Host interno do proxy é aceito');
    const www = await probe.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'www.campanhas.exemplo.com.br', origin: 'https://www.campanhas.exemplo.com.br' }, payload: { email: 'dono@teste.local', password: 'senha-de-teste-123' } });
    assert.equal(www.statusCode, 200, 'o mesmo site com www. também funciona');
    const local = buildApp(fakeProvider);
    try { assert.equal((await local.inject({ method: 'GET', url: '/api/health', headers: { host: 'outro-site.com' } })).statusCode, 403, 'localmente, Host desconhecido é recusado'); }
    finally { await local.close(); }
    assert.equal((await probe.inject({ method: 'POST', url: '/api/auth/login', headers: { ...site, origin: 'http://localhost:3000' }, payload: {} })).statusCode, 403, 'origem local não vale em produção');
  } finally { await probe.close(); }
});

test('panel is served on the same port with SPA fallback, and API 404s stay JSON', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'painel-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const probe = buildApp(fakeProvider, loadConfig({ WEB_DIST: dist }));
  try {
    for (const url of ['/', '/campanhas', '/campanhas/abc/editar', '/login']) {
      const page = await probe.inject({ method: 'GET', url, headers: { host: 'localhost' } });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.body, /id="root"/, url);
    }
    const asset = await probe.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: { host: 'localhost' } });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['cache-control']), /immutable/);
    const missing = await probe.inject({ method: 'GET', url: '/api/nao-existe', headers: auth() });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, 'Rota não encontrada.');
  } finally { await probe.close(); rmSync(dist, { recursive: true, force: true }); }
});

test('uploads are limited per type before buffering, and listings never expose message bodies', async () => {
  const big = Buffer.alloc(IMAGE_LIMIT + 1024);
  const r = await app.inject({ method: 'POST', url: '/api/media?name=grande.png', headers: auth({ 'content-type': 'image/png' }), payload: big });
  assert.equal(r.statusCode, 413);
  assert.equal(r.json().error, 'Arquivo acima do limite permitido.');
  const { id } = await create(1); await activate(id);
  const list = await request('GET', `/deliveries?campaignId=${id}`);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json()[0].messageBody, undefined);
});

// ─── Fluxo de envio real (despachante + conector falso), ADR-012 ────────────────
// O conector falso substitui só o WhatsApp: reserva, gravação, intervalo, reinício e
// eventos do servidor passam pelo código de produção.
const ACCOUNT = '5511900000000@s.whatsapp.net';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Tempo esgotado esperando: ${what}`);
    await sleep(50);
  }
}
let jidSeq = 0;
async function realCampaign(groupCount: number, intervalSeconds = 60) {
  // Só esta campanha fica ativa, para o despachante não processar sobras de outros testes.
  await prisma.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });
  // O relógio do número (ADR-006) é persistido: cada teste começa sem histórico de envio.
  await prisma.whatsAppAccount.deleteMany();
  const now = new Date();
  const groups = [];
  for (let i = 0; i < groupCount; i++) groups.push(await prisma.group.create({ data: { name: `Real ${i}`, userId: ownerId, externalId: `120363${Date.now()}${jidSeq++}@g.us` } }));
  const campaign = await prisma.campaign.create({ data: {
    name: 'Envio real', userId: ownerId, startsAt: now, endsAt: now, status: 'ACTIVE', provider: 'baileys', accountJid: ACCOUNT, mode: 'IMMEDIATE', intervalSeconds, nextAvailableAt: now,
    groups: { create: groups.map((g, position) => ({ groupId: g.id, position })) },
    messages: { create: [{ content: 'oi', position: 0 }] },
    deliveries: { create: groups.map((g, sequence) => ({ groupId: g.id, messageBody: 'oi', provider: 'baileys', sequence, scheduledAt: new Date(now.getTime() + sequence * intervalSeconds * 1000) })) },
  } });
  const rows = await prisma.delivery.findMany({ where: { campaignId: campaign.id }, orderBy: { sequence: 'asc' }, include: { group: true } });
  return { campaign, rows };
}
type SendResult = { messageId: string; context: string };
function fakeWhatsApp(onSend: (jid: string, call: number) => Promise<SendResult>) {
  const calls: string[] = [];
  const provider = {
    status: () => ({ state: 'connected', accountJid: ACCOUNT }),
    send: async (jid: string) => { calls.push(jid); return onSend(jid, calls.length); },
    flushReads: async () => undefined,
    flushDeliveryEvents: async () => undefined,
  } as unknown as SendingProvider;
  // O despachante escolhe a conexão pelo dono da campanha (ADR-022); nos testes, o dono da suíte.
  const router = staticRouter([{ ownerId, provider }]);
  return { provider, calls, router };
}
const fresh = (id: string) => prisma.delivery.findUniqueOrThrow({ where: { id } });
// Libera a próxima entrega "agora" (simula o intervalo já decorrido).
const releaseNext = async (campaignId: string, deliveryId: string) => {
  const past = new Date(Date.now() - 1000);
  // O intervalo do número também "passou". Fora da transação abaixo: a fila trava número
  // antes de campanha, e este atalho não pode inverter essa ordem.
  await prisma.whatsAppAccount.updateMany({ data: { nextAvailableAt: past, lastSendEndedAt: null } });
  // Mesmo lock da fila: sem ele este atalho do teste disputa as linhas com o despachante
  // em execução e o MySQL às vezes o escolhe como vítima de deadlock.
  await prisma.$transaction(async tx => {
    await lockCampaign(tx, campaignId);
    await tx.delivery.update({ where: { id: deliveryId }, data: { scheduledAt: past } });
    await tx.campaign.update({ where: { id: campaignId }, data: { nextAvailableAt: past } });
  }, LOCKING_TRANSACTION);
};

test('successful send: one attempt, times and message id recorded, then delivery receipt marks it delivered', async () => {
  const { campaign, rows: [row] } = await realCampaign(1);
  const wa = fakeWhatsApp(async () => { await sleep(120); return { messageId: '3EB0SUCESSO1', context: 'membro=sim admin=nao so-admins=nao participantes=80' }; });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    const sent = await waitFor(async () => { const d = await fresh(row.id); return d.status === 'SENT' && d; }, 'envio gravado');
    assert.equal(sent.providerId, '3EB0SUCESSO1');
    assert.equal(sent.attempts, 1);
    assert.ok(sent.attemptedAt && sent.sendReturnedAt && sent.attemptedAt <= sent.sendReturnedAt, 'início antes do retorno');
    assert.ok(sent.sendReturnedAt!.getTime() - sent.attemptedAt!.getTime() >= 100, 'a duração do sendMessage fica medida');
    assert.equal(sent.sendContext, 'membro=sim admin=nao so-admins=nao participantes=80');
    assert.equal(sent.deliveredAt, null, 'sem recibo ainda: não se afirma entrega');
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'COMPLETED');
  } finally { await dispatcher.stop(); }
  const event = { kind: 'delivered' as const, messageId: '3EB0SUCESSO1', groupJid: row.group.externalId!, accountJid: ACCOUNT, at: new Date() };
  assert.equal(await applyServerEvent(prisma, event), true);
  assert.equal(await applyServerEvent(prisma, { ...event, at: new Date(Date.now() + 60_000) }), true, 'recibos repetidos são idempotentes');
  const delivered = await fresh(row.id);
  assert.equal(delivered.deliveredAt?.getTime(), event.at.getTime(), 'vale o primeiro recibo');
  assert.equal(delivered.status, 'SENT');
  assert.equal(wa.calls.length, 1);
});

test('sendMessage throwing: failed with the technical code, one attempt, never retried', async () => {
  const { rows: [row] } = await realCampaign(1);
  const wa = fakeWhatsApp(async () => { throw Object.assign(new Error('Timed Out'), { output: { statusCode: 408 } }); });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    const failed = await waitFor(async () => { const d = await fresh(row.id); return d.status === 'FAILED' && d; }, 'falha gravada');
    assert.equal(failed.errorCode, 'baileys:408');
    assert.equal(failed.attempts, 1);
    assert.match(failed.error ?? '', /Timed Out.*incerto.*Sem reenvio automático/);
    assert.ok(failed.sendReturnedAt, 'o momento da falha fica registrado');
    await sleep(400); // vários ciclos do despachante
    assert.equal(wa.calls.length, 1, 'falha não é repetida');
  } finally { await dispatcher.stop(); }
});

test('send accepted locally but refused by the server afterwards: goes back to the queue for a later retry, even if the refusal arrives first', async () => {
  const { rows: [row] } = await realCampaign(1);
  const rejected = { kind: 'rejected' as const, messageId: '3EB0RECUSADO', groupJid: row.group.externalId!, accountJid: ACCOUNT, at: new Date(), code: '479' };
  // A recusa pode chegar antes de o envio ser gravado: não aplica e pede nova tentativa.
  assert.equal(await applyServerEvent(prisma, rejected), false);
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0RECUSADO', context: 'membro=sim admin=nao so-admins=sim participantes=40' }));
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try { await waitFor(async () => (await fresh(row.id)).status === 'SENT', 'envio gravado'); }
  finally { await dispatcher.stop(); }
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: row.campaignId } })).status, 'COMPLETED', 'terminou antes da recusa');
  assert.equal(await applyServerEvent(prisma, rejected), true, 'reaplicada depois da gravação');
  const requeued = await fresh(row.id);
  assert.equal(requeued.status, 'PENDING', 'recusa comprova que nada chegou: volta para a fila');
  assert.equal(requeued.errorCode, 'servidor:479');
  assert.ok(requeued.serverRejectedAt);
  assert.match(requeued.error ?? '', /recusou/);
  const wait = requeued.scheduledAt.getTime() - rejected.at.getTime();
  assert.ok(wait >= 4.9 * 60_000 && wait <= 5.1 * 60_000, 'nova tentativa em 5 minutos, não imediata');
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: row.campaignId } })).status, 'ACTIVE', 'campanha reaberta para a nova tentativa');
  assert.equal(await applyServerEvent(prisma, rejected), true, 'recusa repetida é idempotente');
  assert.equal((await fresh(row.id)).scheduledAt.getTime(), requeued.scheduledAt.getTime(), 'recusa repetida não reagenda');
  assert.equal(wa.calls.length, 1);
  // Se, apesar da recusa, chegar o recibo de entrega da mensagem antiga: cancela o reenvio.
  await applyServerEvent(prisma, { kind: 'delivered', messageId: '3EB0RECUSADO', groupJid: row.group.externalId!, accountJid: ACCOUNT, at: new Date() });
  const delivered = await fresh(row.id);
  assert.equal(delivered.status, 'SENT', 'chegou: não reenvia (nunca duplicar)');
  assert.ok(delivered.deliveredAt);
});

test('server refusal on the last allowed attempt: final failure, no more retries', async () => {
  const { rows: [row] } = await realCampaign(1);
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0ULTIMA', context: 'membro=sim admin=nao so-admins=nao participantes=9' }));
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try { await waitFor(async () => (await fresh(row.id)).status === 'SENT', 'envio gravado'); }
  finally { await dispatcher.stop(); }
  await prisma.delivery.update({ where: { id: row.id }, data: { attempts: 3 } });
  await applyServerEvent(prisma, { kind: 'rejected', messageId: '3EB0ULTIMA', groupJid: row.group.externalId!, accountJid: ACCOUNT, at: new Date(), code: '463' });
  const failed = await fresh(row.id);
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error ?? '', /Falhou nas 3 tentativas.*recusou/);
});

test('failure before anything was sent: retried later up to 3 attempts, without holding back the other groups', async () => {
  const { campaign, rows: [first, second] } = await realCampaign(2, 60);
  const { notSent } = await import('./send-context.js');
  let failFirst = 2; // falha as duas primeiras tentativas no primeiro grupo; a terceira passa
  const wa = fakeWhatsApp(async (jid, call) => {
    if (jid === first.group.externalId && failFirst-- > 0) throw notSent(new Error('Conexão interrompida antes do envio.'));
    return { messageId: `3EB0REENVIO${call}`, context: 'membro=sim admin=nao so-admins=nao participantes=5' };
  });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    const retry = await waitFor(async () => { const d = await fresh(first.id); return d.status === 'PENDING' && d.attempts === 1 && d; }, '1ª falha volta para a fila');
    assert.equal(retry.sequence, first.sequence, 'mantém a posição');
    assert.ok(retry.scheduledAt.getTime() > Date.now() + 4 * 60_000, 'espera ~5 min');
    assert.match(retry.error ?? '', /interrompida/);
    // O segundo grupo não fica preso atrás do reenvio agendado.
    await releaseNext(campaign.id, second.id);
    await waitFor(async () => (await fresh(second.id)).status === 'SENT', 'segundo grupo enviado antes do reenvio');
    await releaseNext(campaign.id, first.id);
    await waitFor(async () => { const d = await fresh(first.id); return d.status === 'PENDING' && d.attempts === 2 && d; }, '2ª falha');
    await releaseNext(campaign.id, first.id);
    const sent = await waitFor(async () => { const d = await fresh(first.id); return d.status === 'SENT' && d; }, '3ª tentativa enviada');
    assert.equal(sent.attempts, 3);
    assert.equal(sent.error, null);
    assert.equal(wa.calls.filter(jid => jid === first.group.externalId).length, 3);
    assert.equal(wa.calls.filter(jid => jid === second.group.externalId).length, 1, 'nenhum grupo recebeu em dobro');
    await waitFor(async () => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status === 'COMPLETED', 'campanha concluída');
  } finally { await dispatcher.stop(); }
});

test('failure before sending, every time: stops after 3 attempts with a final failure', async () => {
  const { campaign, rows: [row] } = await realCampaign(1);
  const { notSent } = await import('./send-context.js');
  const wa = fakeWhatsApp(async () => { throw notSent(Object.assign(new Error('Só administradores podem enviar neste grupo.'), { code: 'grupo:so-admins' })); });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    for (const attempt of [1, 2]) {
      await waitFor(async () => { const d = await fresh(row.id); return d.status === 'PENDING' && d.attempts === attempt; }, `falha ${attempt}`);
      await releaseNext(campaign.id, row.id);
    }
    const failed = await waitFor(async () => { const d = await fresh(row.id); return d.status === 'FAILED' && d; }, 'falha final');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.errorCode, 'grupo:so-admins');
    assert.match(failed.error ?? '', /Falhou nas 3 tentativas/);
    await sleep(300);
    assert.equal(wa.calls.length, 3, 'para depois de 3 tentativas');
  } finally { await dispatcher.stop(); }
});

test('a delivery receipt wins over a late refusal: something that reached the group is not declared failed', async () => {
  const { rows: [row] } = await realCampaign(1);
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0ENTREGUE', context: 'membro=sim admin=sim so-admins=nao participantes=10' }));
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try { await waitFor(async () => (await fresh(row.id)).status === 'SENT', 'envio gravado'); }
  finally { await dispatcher.stop(); }
  const base = { messageId: '3EB0ENTREGUE', groupJid: row.group.externalId!, accountJid: ACCOUNT, at: new Date() };
  await applyServerEvent(prisma, { ...base, kind: 'delivered' });
  await applyServerEvent(prisma, { ...base, kind: 'rejected', code: '500' });
  const d = await fresh(row.id);
  assert.equal(d.status, 'SENT');
  assert.ok(d.deliveredAt);
  assert.equal(d.errorCode, 'servidor:500', 'o código fica registrado para investigação');
});

test('queue delay: the next send waits the interval counted from the end of the previous one, and lateness is measurable', async () => {
  const { campaign, rows: [first, second] } = await realCampaign(2, 60);
  const wa = fakeWhatsApp(async (_jid, call) => { await sleep(150); return { messageId: `3EB0ATRASO${call}`, context: 'membro=sim admin=nao so-admins=nao participantes=5' }; });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    const one = await waitFor(async () => { const d = await fresh(first.id); return d.status === 'SENT' && d; }, 'primeiro envio');
    const next = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).nextAvailableAt!;
    // Comportamento atual (ADR-003): intervalo contado do FIM do envio anterior. Cada envio
    // empurra o seguinte em (duração do envio + espera do ciclo): o atraso se acumula.
    assert.equal(next.getTime(), one.sendReturnedAt!.getTime() + 60_000);
    assert.ok(next.getTime() > first.scheduledAt.getTime() + 60_000, 'a grade planejada já ficou para trás');
    await sleep(300);
    assert.equal(wa.calls.length, 1, 'não envia antes do intervalo');
    await releaseNext(campaign.id, second.id);
    const two = await waitFor(async () => { const d = await fresh(second.id); return d.status === 'SENT' && d; }, 'segundo envio');
    assert.ok(two.attemptedAt! >= two.scheduledAt, 'início registrado; atraso = attemptedAt - scheduledAt');
    assert.equal(two.attempts, 1);
  } finally { await dispatcher.stop(); }
});

test('restart during a campaign: the interrupted send is marked uncertain and never resent; the queue continues in order', async () => {
  const { campaign, rows: [first, second] } = await realCampaign(2, 60);
  // Simula queda no meio do envio: reservado (PROCESSING), sem resultado gravado.
  await prisma.delivery.update({ where: { id: first.id }, data: { status: 'PROCESSING', attemptedAt: new Date(), attempts: 1 } });
  await releaseNext(campaign.id, second.id);
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0APOSREINICIO', context: 'membro=sim admin=nao so-admins=nao participantes=5' }));
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    // O envio interrompido pode ter saído pouco antes da queda: o número espera um intervalo
    // inteiro a partir do reinício (ADR-006) antes do próximo envio.
    await sleep(400);
    assert.equal(wa.calls.length, 0, 'nada sai durante o intervalo após a queda');
    await releaseNext(campaign.id, second.id);
    await waitFor(async () => (await fresh(second.id)).status === 'SENT', 'segundo envio após reinício');
    const interrupted = await fresh(first.id);
    assert.equal(interrupted.status, 'FAILED');
    assert.match(interrupted.error ?? '', /interrompido.*incerto/i);
    assert.equal(interrupted.attempts, 1, 'a tentativa interrompida não é repetida');
    assert.deepEqual(wa.calls, [second.group.externalId], 'só o segundo grupo recebeu envio');
  } finally { await dispatcher.stop(); }
});

test('duplicate prevention: a concurrent claim during a slow send gets nothing and the group receives exactly one send', async () => {
  const { rows: [row] } = await realCampaign(1);
  let inside!: () => void;
  const sending = new Promise<void>(resolve => { inside = resolve; });
  const wa = fakeWhatsApp(async () => { inside(); await sleep(400); return { messageId: '3EB0UNICO', context: 'membro=sim admin=nao so-admins=nao participantes=5' }; });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 20 });
  try {
    await sending;
    assert.equal(await claimDelivery(prisma, row.id), null, 'outra reserva enquanto envia: recusada');
    await waitFor(async () => (await fresh(row.id)).status === 'SENT', 'envio gravado');
    await sleep(300); // mais ciclos do despachante depois de enviado
    assert.equal(wa.calls.length, 1);
    assert.equal((await fresh(row.id)).attempts, 1);
    assert.equal(await claimDelivery(prisma, row.id), null, 'enviado não é reservado de novo');
  } finally { await dispatcher.stop(); }
});

// ─── Intervalo mínimo por NÚMERO (ADR-006) ──────────────────────────────────────
// Invariante: para um mesmo número, início do envio N+1 − fim do envio N ≥ intervalo, somando
// todas as campanhas. Intervalos curtos (2 s) medem o tempo real sem deixar a suíte lenta;
// antes da correção as campanhas se revezavam a cada 1,5 s (SEND_SPACING_MS).
const PACE_S = 2;
// O relógio do número é persistido; cada teste começa sem histórico de envio.
const resetPace = () => prisma.$executeRawUnsafe('DELETE FROM `WhatsAppAccount`').catch(() => 0);

async function sameNumberCampaigns(count: number, groupsEach: number, intervalSeconds = PACE_S) {
  await prisma.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });
  await resetPace();
  const now = new Date(Date.now() - 1000);
  const campaigns = [];
  for (let c = 0; c < count; c++) {
    const groups = [];
    for (let i = 0; i < groupsEach; i++) groups.push(await prisma.group.create({ data: { name: `Ritmo ${c}.${i}`, userId: ownerId, externalId: `120399${Date.now()}${jidSeq++}@g.us` } }));
    const campaign = await prisma.campaign.create({ data: {
      name: `Mesmo número ${c}`, userId: ownerId, startsAt: now, endsAt: now, status: 'ACTIVE', provider: 'baileys', accountJid: ACCOUNT, mode: 'IMMEDIATE', intervalSeconds, nextAvailableAt: now,
      groups: { create: groups.map((g, position) => ({ groupId: g.id, position })) },
      messages: { create: [{ content: 'oi', position: 0 }] },
      deliveries: { create: groups.map((g, sequence) => ({ groupId: g.id, messageBody: 'oi', provider: 'baileys', sequence, scheduledAt: new Date(now.getTime() + sequence * intervalSeconds * 1000) })) },
    } });
    campaigns.push(campaign);
  }
  return campaigns;
}
const campaignRows = (ids: string[]) => prisma.delivery.findMany({ where: { campaignId: { in: ids } }, include: { group: true } });
const okSend = (jid: string, call: number) => sleep(40).then(() => ({ messageId: `3EB0RITMO${call}${jid.slice(6, 14)}`, context: 'membro=sim admin=nao so-admins=nao participantes=5' }));

// Todo par de tentativas consecutivas no número respeita o intervalo (fim → início).
function assertPaced(rows: { attemptedAt: Date | null; sendReturnedAt: Date | null }[], minMs: number) {
  const attempts = rows.filter(r => r.attemptedAt && r.sendReturnedAt).sort((a, b) => a.attemptedAt!.getTime() - b.attemptedAt!.getTime());
  for (let i = 1; i < attempts.length; i++) {
    const gap = attempts[i].attemptedAt!.getTime() - attempts[i - 1].sendReturnedAt!.getTime();
    assert.ok(gap >= minMs, `tentativa ${i + 1} saiu ${gap} ms depois da anterior (mínimo ${minMs} ms)`);
  }
}

test('pace, one campaign: keeps sending in order with the interval between sends', async () => {
  const [campaign] = await sameNumberCampaigns(1, 3);
  const wa = fakeWhatsApp(okSend);
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    await waitFor(async () => (await campaignRows([campaign.id])).every(d => d.status === 'SENT'), 'campanha enviada', 20_000);
    const rows = await campaignRows([campaign.id]);
    assertPaced(rows, PACE_S * 1000);
    const order = rows.sort((x, y) => x.attemptedAt!.getTime() - y.attemptedAt!.getTime()).map(r => r.sequence);
    assert.deepEqual(order, [0, 1, 2]);
    assert.equal(wa.calls.length, 3);
  } finally { await dispatcher.stop(); }
});

for (const count of [2, 3]) test(`pace, ${count} campaigns on the same number: never faster than the interval`, async () => {
  const campaigns = await sameNumberCampaigns(count, 2);
  const ids = campaigns.map(c => c.id);
  const wa = fakeWhatsApp(okSend);
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    await waitFor(async () => (await campaignRows(ids)).every(d => d.status === 'SENT'), 'todas enviadas', 30_000);
    const rows = await campaignRows(ids);
    assertPaced(rows, PACE_S * 1000);
    assert.equal(wa.calls.length, count * 2, 'um envio por grupo');
    // Revezamento justo: a segunda campanha não espera a primeira terminar tudo.
    const order = rows.sort((x, y) => x.attemptedAt!.getTime() - y.attemptedAt!.getTime()).map(r => r.campaignId);
    assert.notEqual(order[0], order[1], 'as campanhas se revezam no número');
  } finally { await dispatcher.stop(); }
});

test('pace, pause and resume: resuming a campaign does not bypass the number interval', async () => {
  const [a, b] = await sameNumberCampaigns(2, 2);
  const wa = fakeWhatsApp(okSend);
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    await waitFor(async () => (await campaignRows([a.id, b.id])).some(d => d.status === 'SENT'), 'primeiro envio');
    // Pausa B como a rota faz e retoma logo depois, já com o próximo envio "vencido".
    await prisma.$transaction(async tx => { await lockCampaign(tx, b.id); await tx.campaign.update({ where: { id: b.id }, data: { status: 'PAUSED', pausedAt: new Date() } }); }, LOCKING_TRANSACTION);
    await sleep(300);
    await prisma.$transaction(async tx => {
      await lockCampaign(tx, b.id);
      await tx.campaign.update({ where: { id: b.id }, data: { status: 'ACTIVE', pausedAt: null, nextAvailableAt: new Date(Date.now() - 60_000) } });
    }, LOCKING_TRANSACTION);
    await waitFor(async () => (await campaignRows([a.id, b.id])).every(d => d.status === 'SENT'), 'todas enviadas', 30_000);
    assertPaced(await campaignRows([a.id, b.id]), PACE_S * 1000);
    assert.equal(wa.calls.length, 4);
  } finally { await dispatcher.stop(); }
});

test('pace, restart after a finished send: the new process still waits the interval since that send', async () => {
  const [a, b] = await sameNumberCampaigns(2, 1, 3);
  await prisma.campaign.update({ where: { id: b.id }, data: { status: 'PAUSED' } });
  const wa = fakeWhatsApp(okSend);
  let dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  await waitFor(async () => (await campaignRows([a.id])).every(d => d.status === 'SENT'), 'envio de A');
  await dispatcher.stop();
  await prisma.campaign.update({ where: { id: b.id }, data: { status: 'ACTIVE', nextAvailableAt: new Date(Date.now() - 60_000) } });
  dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 }); // "reinício" do processo
  try {
    await waitFor(async () => (await campaignRows([b.id])).every(d => d.status === 'SENT'), 'envio de B', 20_000);
    assertPaced(await campaignRows([a.id, b.id]), 3000);
  } finally { await dispatcher.stop(); }
});

test('pace, crash in the middle of a send: after restart the number waits a full interval', async () => {
  const [a, b] = await sameNumberCampaigns(2, 1, 3);
  const [interrupted] = await campaignRows([a.id]);
  // Reserva real (como o despachante faria) e o processo "morre" antes de gravar o resultado.
  assert.ok(await claimDelivery(prisma, interrupted.id));
  await prisma.campaign.update({ where: { id: b.id }, data: { nextAvailableAt: new Date(Date.now() - 60_000) } });
  const bootAt = (await currentTime()).getTime(); // mesmo relógio da fila
  const wa = fakeWhatsApp(okSend);
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    await waitFor(async () => (await campaignRows([b.id])).every(d => d.status === 'SENT'), 'envio de B', 20_000);
    const [sentB] = await campaignRows([b.id]);
    assert.ok(sentB.attemptedAt!.getTime() - bootAt >= 3000, 'o envio interrompido pode ter saído a qualquer momento antes do reinício');
    assert.equal((await fresh(interrupted.id)).status, 'FAILED', 'interrompido continua incerto, sem reenvio');
    assert.deepEqual(wa.calls, [sentB.group.externalId]);
  } finally { await dispatcher.stop(); }
});

test('pace, failures and retries on a shared number: no duplicate and no send faster than the interval', async () => {
  const [a, b] = await sameNumberCampaigns(2, 2);
  const [aFirst, aSecond] = (await campaignRows([a.id])).sort((x, y) => x.sequence - y.sequence);
  const { notSent } = await import('./send-context.js');
  const wa = fakeWhatsApp(async (jid, call) => {
    if (jid === aFirst.group.externalId) throw notSent(new Error('Conexão interrompida antes do envio.'));
    if (jid === aSecond.group.externalId) throw new Error('Timed Out');
    return okSend(jid, call);
  });
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try {
    await waitFor(async () => {
      const rows = await campaignRows([a.id, b.id]);
      return rows.filter(r => r.campaignId === b.id).every(r => r.status === 'SENT') && rows.find(r => r.id === aSecond.id)?.status === 'FAILED';
    }, 'B enviada e A processada', 30_000);
    const rows = await campaignRows([a.id, b.id]);
    assertPaced(rows, PACE_S * 1000);
    assert.equal(rows.find(r => r.id === aFirst.id)?.status, 'PENDING', 'falha antes de enviar volta para a fila (5 min)');
    for (const row of rows) assert.equal(wa.calls.filter(jid => jid === row.group.externalId).length, 1, `grupo ${row.group.name}: uma única tentativa`);
  } finally { await dispatcher.stop(); }
});

// ─── Papéis e autorização (ADR-016) ─────────────────────────────────────────────
// Um app separado com uma rota administrativa de prova: ainda não existem rotas de admin.
function roleApp() {
  const probe = buildApp({ status: () => ({ state: 'disconnected' }), connect: async () => ({ state: 'disconnected' }), disconnect: async () => ({ state: 'disconnected' }), sync: async () => ({ count: 0 }), hasPairedSession: async () => false });
  probe.get('/api/admin/probe', { preHandler: requireSuperAdmin }, async request => ({ ok: true, role: request.user!.role }));
  probe.post('/api/admin/probe', { preHandler: requireSuperAdmin }, async () => ({ ok: true }));
  return probe;
}
async function loginAs(target: ReturnType<typeof buildApp>, email: string, password = 'senha-de-teste-123') {
  const r = await target.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost', origin: PANEL }, payload: { email, password } });
  return { status: r.statusCode, body: r.json(), cookie: r.statusCode === 200 ? String(r.headers['set-cookie']).split(';')[0] : '' };
}
const as = (sessionCookie: string, extra: Record<string, string> = {}) => ({ host: 'localhost', origin: PANEL, cookie: sessionCookie, ...extra });

test('roles: SUPER_ADMIN and USER are recognized from the server session; new accounts default to USER', async () => {
  const probe = roleApp();
  try {
    const passwordHash = await hashPassword('senha-de-teste-123');
    const admin = await prisma.user.create({ data: { email: 'super@teste.local', name: 'Super', role: 'SUPER_ADMIN', passwordHash } });
    const user = await prisma.user.create({ data: { email: 'comum@teste.local', name: 'Comum', passwordHash } });
    assert.equal(user.role, 'USER', 'papel padrão é USER');
    const a = await loginAs(probe, admin.email);
    const u = await loginAs(probe, user.email);
    assert.equal(a.body.user.role, 'SUPER_ADMIN');
    assert.equal(u.body.user.role, 'USER');
    assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: as(a.cookie) })).json().user.role, 'SUPER_ADMIN');
    assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: as(u.cookie) })).json().user.role, 'USER');
  } finally { await probe.close(); }
});

test('requireSuperAdmin: anonymous 401, USER 403 (even claiming to be admin), SUPER_ADMIN passes', async () => {
  const probe = roleApp();
  try {
    const a = await loginAs(probe, 'super@teste.local');
    const u = await loginAs(probe, 'comum@teste.local');
    assert.equal((await probe.inject({ method: 'GET', url: '/api/admin/probe', headers: { host: 'localhost' } })).statusCode, 401);
    assert.equal((await probe.inject({ method: 'GET', url: '/api/admin/probe', headers: as(u.cookie) })).statusCode, 403);
    const ok = await probe.inject({ method: 'GET', url: '/api/admin/probe', headers: as(a.cookie) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().role, 'SUPER_ADMIN');
    // Nada vindo do navegador decide o papel: cabeçalho, query, corpo e cookie extra são ignorados.
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'super@teste.local' } });
    assert.equal((await probe.inject({ method: 'GET', url: '/api/admin/probe?role=SUPER_ADMIN', headers: as(`${u.cookie}; role=SUPER_ADMIN`, { 'x-role': 'SUPER_ADMIN', 'x-user-id': admin.id }) })).statusCode, 403);
    assert.equal((await probe.inject({ method: 'POST', url: '/api/admin/probe', headers: as(u.cookie), payload: { role: 'SUPER_ADMIN', userId: admin.id } })).statusCode, 403);
  } finally { await probe.close(); }
});

test('roles: a USER keeps using the normal authenticated routes', async () => {
  const probe = roleApp();
  try {
    const u = await loginAs(probe, 'comum@teste.local');
    for (const url of ['/api/campaigns', '/api/groups', '/api/deliveries', '/api/dashboard', '/api/whatsapp/status', '/api/auth/me']) {
      assert.equal((await probe.inject({ method: 'GET', url, headers: as(u.cookie) })).statusCode, 200, url);
    }
  } finally { await probe.close(); }
});

test('roles: a role change in the database applies on the next request, without logging in again', async () => {
  const probe = roleApp();
  try {
    const a = await loginAs(probe, 'super@teste.local');
    await prisma.user.update({ where: { email: 'super@teste.local' }, data: { role: 'USER' } });
    assert.equal((await probe.inject({ method: 'GET', url: '/api/admin/probe', headers: as(a.cookie) })).statusCode, 403, 'rebaixado perde o acesso na hora');
    await prisma.user.update({ where: { email: 'super@teste.local' }, data: { role: 'SUPER_ADMIN' } });
    assert.equal((await probe.inject({ method: 'GET', url: '/api/admin/probe', headers: as(a.cookie) })).statusCode, 200);
  } finally { await probe.close(); }
});

test('disabledAt: blocks open sessions and new logins, for USER and SUPER_ADMIN', async () => {
  const probe = roleApp();
  try {
    for (const email of ['comum@teste.local', 'super@teste.local']) {
      const session = await loginAs(probe, email);
      await prisma.user.update({ where: { email }, data: { disabledAt: new Date() } });
      assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: as(session.cookie) })).statusCode, 401, `${email}: sessão aberta cai`);
      assert.equal((await probe.inject({ method: 'GET', url: '/api/admin/probe', headers: as(session.cookie) })).statusCode, 401);
      assert.equal((await loginAs(probe, email)).status, 401, `${email}: login recusado`);
      await prisma.user.update({ where: { email }, data: { disabledAt: null } });
      assert.equal((await loginAs(probe, email)).status, 200, `${email}: reativado entra de novo`);
    }
  } finally { await probe.close(); }
});

test('migration: a legacy OWNER becomes SUPER_ADMIN keeping password and sessions; unknown roles become USER', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { randomBytes } = await import('node:crypto');
  const { PrismaClient } = await import('@prisma/client');
  const dir = join(process.cwd(), 'packages/database/prisma/migrations');
  const all = readdirSync(dir).filter(name => /^\d{14}_/.test(name)).sort();
  const target = '20260922140000_user_roles';
  assert.ok(all.includes(target));
  const statements = (name: string) => readFileSync(join(dir, name, 'migration.sql'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map(sql => sql.trim()).filter(Boolean);
  // Banco próprio e descartável, com as migrations ANTERIORES aplicadas: o estado de antes.
  const legacy = `campaign_test_${randomBytes(8).toString('hex')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${legacy}`;
  await prisma.$executeRawUnsafe(`CREATE DATABASE \`${legacy}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    for (const name of all.slice(0, all.indexOf(target))) for (const sql of statements(name)) await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe("INSERT INTO `User` (id, email, name, passwordHash, role, updatedAt) VALUES ('u-owner', 'dono@antigo', 'Dono', 'scrypt$hash-original', 'OWNER', NOW(3)), ('u-other', 'x@antigo', 'X', 'h', 'OPERATOR', NOW(3))");
    await db.$executeRawUnsafe("INSERT INTO `AuthSession` (id, userId, tokenHash, expiresAt) VALUES ('s1', 'u-owner', REPEAT('a', 64), DATE_ADD(NOW(3), INTERVAL 1 DAY))");
    for (const sql of statements(target)) await db.$executeRawUnsafe(sql);
    const rows = await db.$queryRawUnsafe<{ id: string; role: string; passwordHash: string }[]>('SELECT id, role, passwordHash FROM `User` ORDER BY id');
    assert.deepEqual(rows.map(r => [r.id, r.role]), [['u-other', 'USER'], ['u-owner', 'SUPER_ADMIN']]);
    assert.equal(rows.find(r => r.id === 'u-owner')?.passwordHash, 'scrypt$hash-original', 'senha intacta');
    assert.equal(Number((await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM `AuthSession` WHERE userId = 'u-owner'"))[0].n), 1, 'sessão mantida');
    await db.$executeRawUnsafe("INSERT INTO `User` (id, email, name, passwordHash, updatedAt) VALUES ('u-new', 'novo@antigo', 'Novo', 'h', NOW(3))");
    assert.equal((await db.$queryRawUnsafe<{ role: string }[]>("SELECT role FROM `User` WHERE id = 'u-new'"))[0].role, 'USER', 'padrão novo é USER');
  } finally {
    await db.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${legacy}\``);
  }
});

// ─── Dono dos dados (ADR-017) ───────────────────────────────────────────────────
async function otherUser() {
  return prisma.user.upsert({ where: { email: 'intruso@teste.local' }, update: {}, create: { email: 'intruso@teste.local', name: 'Intruso', passwordHash: await hashPassword('senha-de-teste-123') } });
}
const pngBytes = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#654321' } }).png().toBuffer();

test('ownership: group, media and campaign created through the API belong to the logged-in user; a userId from the client is ignored', async () => {
  const other = await otherUser();
  const group = await app.inject({ method: 'POST', url: `/api/groups?userId=${other.id}`, headers: auth({ 'x-user-id': other.id }), payload: { name: 'Grupo do dono', userId: other.id } });
  assert.equal(group.statusCode, 201, group.body);
  assert.equal(group.json().userId, ownerId, 'grupo: dono = sessão');
  const media = await app.inject({ method: 'POST', url: `/api/media?name=dono.png&userId=${other.id}`, headers: auth({ 'content-type': 'image/png', 'x-user-id': other.id }), payload: await pngBytes() });
  assert.equal(media.statusCode, 201, media.body);
  assert.equal((await prisma.campaignMedia.findUniqueOrThrow({ where: { id: media.json().id } })).userId, ownerId, 'mídia: dono = sessão');
  const campaign = await app.inject({ method: 'POST', url: '/api/campaigns', headers: auth({ 'x-user-id': other.id }), payload: { name: 'Do dono', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds: [group.json().id], mediaId: media.json().id, userId: other.id } });
  assert.equal(campaign.statusCode, 201, campaign.body);
  const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.json().id }, include: { groups: true } });
  assert.equal(saved.userId, ownerId, 'campanha: dono = sessão');
  assert.deepEqual(saved.groups.map(g => g.userId), [ownerId], 'vínculo campanha-grupo herda o dono');
  assert.equal(saved.mediaId, media.json().id);
});

test('ownership: two users may own the same WhatsApp group; one user cannot own it twice', async () => {
  const other = await otherUser();
  const jid = `120377${Date.now()}@g.us`;
  const mine = await prisma.group.create({ data: { name: 'Compartilhado', externalId: jid, userId: ownerId } });
  const theirs = await prisma.group.create({ data: { name: 'Compartilhado', externalId: jid, userId: other.id } });
  assert.notEqual(mine.id, theirs.id, 'cada usuário tem a sua linha do mesmo grupo');
  await assert.rejects(prisma.group.create({ data: { name: 'Repetido', externalId: jid, userId: ownerId } }), (e: { code?: string }) => e.code === 'P2002', 'mesmo dono + mesmo grupo: recusado');
});

test('ownership: the database refuses a campaign using another user\'s group or media, and the API answers 400', async () => {
  const other = await otherUser();
  const theirGroup = await prisma.group.create({ data: { name: 'Grupo do intruso', userId: other.id } });
  const theirMedia = await prisma.campaignMedia.create({ data: { name: 'intruso.png', mimeType: 'image/png', kind: 'image', size: 4, data: new Uint8Array([1, 2, 3, 4]), userId: other.id } });
  const myGroup = await prisma.group.create({ data: { name: 'Meu grupo', userId: ownerId } });
  const now = new Date();
  const mine = await prisma.campaign.create({ data: { name: 'Minha', userId: ownerId, startsAt: now, endsAt: now, groups: { create: [{ groupId: myGroup.id, position: 0 }] } } });
  // Banco: grupo de outro usuário, com qualquer userId no vínculo.
  await assert.rejects(prisma.campaignGroup.create({ data: { campaignId: mine.id, groupId: theirGroup.id, userId: ownerId } }), 'vínculo com grupo alheio (dono da campanha)');
  await assert.rejects(prisma.campaignGroup.create({ data: { campaignId: mine.id, groupId: theirGroup.id, userId: other.id } }), 'vínculo com grupo alheio (dono do grupo)');
  // Banco: mídia de outro usuário.
  await assert.rejects(prisma.campaign.update({ where: { id: mine.id }, data: { mediaId: theirMedia.id } }), 'mídia alheia');
  await assert.rejects(prisma.campaign.create({ data: { name: 'Com mídia alheia', userId: ownerId, startsAt: now, endsAt: now, mediaId: theirMedia.id } }));
  assert.equal((await prisma.campaignGroup.count({ where: { campaignId: mine.id } })), 1, 'nada foi vinculado');
  // API: recusa com mensagem clara em vez de erro do banco.
  const withGroup = await request('POST', '/campaigns', { name: 'X', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds: [theirGroup.id] });
  assert.equal(withGroup.statusCode, 400, withGroup.body);
  const withMedia = await request('POST', '/campaigns', { name: 'X', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds: [myGroup.id], mediaId: theirMedia.id });
  assert.equal(withMedia.statusCode, 400, withMedia.body);
  const draft = await request('POST', '/campaigns', { name: 'Rascunho', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds: [myGroup.id] });
  const edit = await request('PATCH', `/campaigns/${draft.json().id}`, { name: 'Rascunho', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds: [theirGroup.id] });
  assert.equal(edit.statusCode, 400, edit.body);
});

test('ownership: WhatsApp sync imports groups for the logged-in user and never deactivates another user\'s groups', async () => {
  const { WhatsAppProvider } = await import('./whatsapp.js');
  const other = await otherUser();
  const shared = `120388${Date.now()}@g.us`;
  const onlyMine = `120389${Date.now()}@g.us`;
  const fakeSync = (groups: string[]) => {
    const provider = new WhatsAppProvider(mkdtempSync(join(tmpdir(), 'wa-sync-')));
    Object.assign(provider, {
      data: { state: 'connected', accountJid: ACCOUNT },
      socket: { user: { id: ACCOUNT }, groupFetchAllParticipating: async () => Object.fromEntries(groups.map(id => [id, { id, subject: `Grupo ${id.slice(6, 12)}`, size: 7, participants: [] }])) },
    });
    return provider;
  };
  await fakeSync([shared, onlyMine]).sync(ownerId);
  await fakeSync([shared]).sync(other.id);
  const rows = await prisma.group.findMany({ where: { externalId: { in: [shared, onlyMine] } } });
  assert.deepEqual(rows.filter(r => r.externalId === shared).map(r => r.userId).sort(), [ownerId, other.id].sort(), 'o mesmo grupo para os dois donos');
  assert.ok(rows.every(r => r.active), 'a sincronização do intruso não desativou nada do dono');
  // Nova sincronização do dono sem o grupo compartilhado: desativa só a linha DELE.
  await fakeSync([onlyMine]).sync(ownerId);
  const after = await prisma.group.findMany({ where: { externalId: shared } });
  assert.equal(after.find(r => r.userId === ownerId)?.active, false);
  assert.equal(after.find(r => r.userId === other.id)?.active, true);
});

// Migrations aplicadas uma a uma num MySQL real e descartável, a partir de um estado antigo.
const MIGRATIONS_DIR = join(process.cwd(), 'packages/database/prisma/migrations');
function migrationStatements(name: string) {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map(sql => sql.trim()).filter(Boolean);
}
async function withLegacyDatabase(fn: (db: import('@prisma/client').PrismaClient, apply: (name: string) => Promise<void>, names: string[]) => Promise<void>) {
  const { randomBytes } = await import('node:crypto');
  const { PrismaClient } = await import('@prisma/client');
  const names = readdirSync(MIGRATIONS_DIR).filter(name => /^\d{14}_/.test(name)).sort();
  const legacy = `campaign_test_${randomBytes(8).toString('hex')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${legacy}`;
  url.searchParams.set('connection_limit', '1'); // a trava da migration usa tabela temporária (mesma conexão)
  await prisma.$executeRawUnsafe(`CREATE DATABASE \`${legacy}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const apply = async (name: string) => { for (const sql of migrationStatements(name)) await db.$executeRawUnsafe(sql); };
  try { await fn(db, apply, names); }
  finally { await db.$disconnect(); await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${legacy}\``); }
}
const OWNERSHIP = '20260922160000_data_ownership';
const hasColumn = async (db: import('@prisma/client').PrismaClient, table: string, column: string) =>
  Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`))[0].n) > 0;

test('migration (real MySQL): legacy OWNER data goes through roles + ownership intact, owned by the SUPER_ADMIN', async () => {
  await withLegacyDatabase(async (db, apply, names) => {
    // Estado do banco local do dono hoje: até a migration de ritmo, conta OWNER, dados reais.
    for (const name of names.slice(0, names.indexOf('20260922140000_user_roles'))) await apply(name);
    const x = (sql: string) => db.$executeRawUnsafe(sql);
    await x("INSERT INTO `User` (id, email, name, passwordHash, role, updatedAt) VALUES ('u-dono', 'dono@antigo', 'Dono', 'h', 'OWNER', NOW(3))");
    await x("INSERT INTO `AuthSession` (id, userId, tokenHash, expiresAt) VALUES ('s1', 'u-dono', REPEAT('b', 64), DATE_ADD(NOW(3), INTERVAL 1 DAY))");
    await x("INSERT INTO `Group` (id, externalId, name, updatedAt) VALUES ('g1', '1203001@g.us', 'Arraxta', NOW(3)), ('g2', '1203002@g.us', 'Arraxta', NOW(3)), ('g3', NULL, 'Manual', NOW(3))");
    await x("INSERT INTO `CampaignMedia` (id, name, mimeType, kind, size, data) VALUES ('m1', 'a.png', 'image/png', 'image', 3, 0x010203)");
    await x("INSERT INTO `Campaign` (id, name, startsAt, endsAt, status, provider, accountJid, mode, intervalSeconds, nextAvailableAt, mediaId, updatedAt) VALUES ('c1', 'Festival', '2026-09-21 17:00:00.000', '2026-09-21 17:00:00.000', 'ACTIVE', 'baileys', '5511@s.whatsapp.net', 'SCHEDULED', 180, '2026-09-21 17:03:00.000', 'm1', NOW(3)), ('c2', 'Rascunho', NOW(3), NOW(3), 'DRAFT', 'simulator', NULL, 'IMMEDIATE', 60, NULL, NULL, NOW(3))");
    await x("INSERT INTO `CampaignGroup` (campaignId, groupId, position) VALUES ('c1', 'g1', 0), ('c1', 'g2', 1), ('c2', 'g3', 0)");
    await x("INSERT INTO `CampaignMessage` (id, campaignId, content) VALUES ('msg1', 'c1', 'Garanta seu ingresso')");
    await x("INSERT INTO `CampaignSchedule` (id, campaignId, time) VALUES ('sch1', 'c1', '14:00')");
    await x("INSERT INTO `Delivery` (id, campaignId, groupId, messageBody, scheduledAt, sentAt, status, provider, providerId, sequence, deliveredAt, updatedAt) VALUES ('d1', 'c1', 'g1', 'oi', '2026-09-21 17:00:00.000', '2026-09-21 17:00:05.000', 'SENT', 'baileys', '3EB0A', 0, '2026-09-21 17:00:09.000', NOW(3)), ('d2', 'c1', 'g2', 'oi', '2026-09-21 17:03:00.000', NULL, 'PENDING', 'baileys', NULL, 1, NULL, NOW(3))");
    await x("INSERT INTO `DeliveryRead` (id, deliveryId, recipientHash, readAt) VALUES ('r1', 'd1', 'h1', NOW(3)), ('r2', 'd1', 'h2', NOW(3))");
    await x("INSERT INTO `PendingRead` (id, messageId, groupJid, accountJid, participant, readAt) VALUES ('p1', '3EB0Z', '1203001@g.us', '5511@s.whatsapp.net', 'x', NOW(3))");
    await x("INSERT INTO `WhatsAppAccount` (id, nextAvailableAt, lastSendEndedAt, lastIntervalSeconds) VALUES ('5511@s.whatsapp.net', '2026-09-21 17:03:05.000', '2026-09-21 17:00:05.000', 180)");
    const tables = ['User', 'AuthSession', 'Group', 'CampaignMedia', 'Campaign', 'CampaignGroup', 'CampaignMessage', 'CampaignSchedule', 'Delivery', 'DeliveryRead', 'PendingRead', 'WhatsAppAccount'];
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async t => [t, Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n)])));
    const snapshot = 'SELECT id, campaignId, groupId, scheduledAt, sentAt, status, providerId, deliveredAt, sequence FROM `Delivery` ORDER BY id';
    const before = await count();
    const deliveriesBefore = JSON.stringify(await db.$queryRawUnsafe(snapshot));
    const paceBefore = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM `WhatsAppAccount`'));

    for (const name of names.slice(names.indexOf('20260922140000_user_roles'), names.indexOf(OWNERSHIP) + 1)) await apply(name);

    assert.deepEqual(await count(), before, 'nenhuma linha apagada ou duplicada em nenhuma tabela');
    assert.equal(JSON.stringify(await db.$queryRawUnsafe(snapshot)), deliveriesBefore, 'envios, horários e agendamento intactos');
    assert.equal(JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM `WhatsAppAccount`')), paceBefore, 'ritmo do número intacto');
    assert.equal((await db.$queryRawUnsafe<{ role: string }[]>("SELECT role FROM `User` WHERE id = 'u-dono'"))[0].role, 'SUPER_ADMIN');
    for (const t of ['Group', 'Campaign', 'CampaignMedia', 'CampaignGroup']) {
      assert.deepEqual(await db.$queryRawUnsafe(`SELECT DISTINCT userId FROM \`${t}\``), [{ userId: 'u-dono' }], `${t}: tudo do SUPER_ADMIN`);
    }
    // Relações continuam de pé: leituras → envio → campanha (com mídia) → grupos.
    const reads = await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM `DeliveryRead` r JOIN `Delivery` d ON d.id = r.deliveryId JOIN `Campaign` c ON c.id = d.campaignId JOIN `CampaignMedia` m ON m.id = c.mediaId AND m.userId = c.userId WHERE c.id = 'c1'");
    assert.equal(Number(reads[0].n), 2, 'métricas ligadas ao envio, à campanha e à mídia do mesmo dono');
    assert.equal(Number((await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM `AuthSession` WHERE userId = 'u-dono'"))[0].n), 1, 'sessão mantida');
    // As novas proteções já valem no banco migrado.
    await db.$executeRawUnsafe("INSERT INTO `User` (id, email, name, passwordHash, updatedAt) VALUES ('u-b', 'b@antigo', 'B', 'h', NOW(3))");
    await db.$executeRawUnsafe("INSERT INTO `Group` (id, userId, externalId, name, updatedAt) VALUES ('g1b', 'u-b', '1203001@g.us', 'Arraxta', NOW(3))");
    await assert.rejects(db.$executeRawUnsafe("INSERT INTO `Group` (id, userId, externalId, name, updatedAt) VALUES ('g1c', 'u-dono', '1203001@g.us', 'X', NOW(3))"), /Duplicate/);
    await assert.rejects(db.$executeRawUnsafe("INSERT INTO `CampaignGroup` (campaignId, groupId, userId) VALUES ('c2', 'g1b', 'u-dono')"), /foreign key/i);
    await assert.rejects(db.$executeRawUnsafe("DELETE FROM `User` WHERE id = 'u-dono'"), /foreign key/i, 'conta com dados não pode ser apagada');
  });
});

for (const scenario of [
  { name: 'two active SUPER_ADMINs', users: "('a1', 'a1@x', 'A', 'h', 'SUPER_ADMIN', NULL), ('a2', 'a2@x', 'B', 'h', 'SUPER_ADMIN', NULL)" },
  { name: 'no SUPER_ADMIN at all', users: "('u1', 'u1@x', 'U', 'h', 'USER', NULL)" },
]) test(`migration (real MySQL): with data and ${scenario.name}, it stops before changing anything`, async () => {
  await withLegacyDatabase(async (db, apply, names) => {
    for (const name of names.slice(0, names.indexOf(OWNERSHIP))) await apply(name);
    await db.$executeRawUnsafe(`INSERT INTO \`User\` (id, email, name, passwordHash, role, disabledAt, updatedAt) VALUES ${scenario.users.replaceAll(', NULL)', ', NULL, NOW(3))')}`);
    await db.$executeRawUnsafe("INSERT INTO `Group` (id, externalId, name, updatedAt) VALUES ('g1', '1203001@g.us', 'Grupo', NOW(3))");
    await assert.rejects(apply(OWNERSHIP), /fase2_precisa_de_um_unico_SUPER_ADMIN_ativo/);
    assert.equal(await hasColumn(db, 'Group', 'userId'), false, 'nenhuma tabela foi alterada');
    assert.equal(await hasColumn(db, 'Campaign', 'userId'), false);
    assert.equal(Number((await db.$queryRawUnsafe<{ n: bigint }[]>('SELECT COUNT(*) AS n FROM `Group`'))[0].n), 1, 'dados intactos');
  });
});

test('migration (real MySQL): a disabled SUPER_ADMIN does not count; an empty database needs no SUPER_ADMIN', async () => {
  await withLegacyDatabase(async (db, apply, names) => {
    for (const name of names.slice(0, names.indexOf(OWNERSHIP))) await apply(name);
    await db.$executeRawUnsafe("INSERT INTO `User` (id, email, name, passwordHash, role, disabledAt, updatedAt) VALUES ('ativo', 'a@x', 'A', 'h', 'SUPER_ADMIN', NULL, NOW(3)), ('inativo', 'i@x', 'I', 'h', 'SUPER_ADMIN', NOW(3), NOW(3))");
    await db.$executeRawUnsafe("INSERT INTO `Group` (id, externalId, name, updatedAt) VALUES ('g1', '1203001@g.us', 'Grupo', NOW(3))");
    await apply(OWNERSHIP);
    assert.deepEqual(await db.$queryRawUnsafe('SELECT userId FROM `Group`'), [{ userId: 'ativo' }]);
  });
  await withLegacyDatabase(async (db, apply, names) => {
    for (const name of names) await apply(name); // instalação nova: nenhum usuário, nenhum dado
    assert.equal(await hasColumn(db, 'Campaign', 'userId'), true);
  });
});

// ─── Isolamento das APIs por usuário (ADR-018) ──────────────────────────────────
// Usuários reais, login pela rota real, dados criados pela API. B tenta tudo com ids de A e
// vice-versa; de fora, recurso alheio e recurso inexistente precisam ser indistinguíveis.
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function isoUser(email: string, role: 'USER' | 'SUPER_ADMIN' = 'USER') {
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, name: email.split('@')[0], role, passwordHash: await hashPassword('senha-de-teste-123') } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost', origin: PANEL }, payload: { email, password: 'senha-de-teste-123' } });
  assert.equal(login.statusCode, 200, login.body);
  const session = String(login.headers['set-cookie']).split(';')[0];
  const call = (method: Method, url: string, payload?: object | Buffer, extra: Record<string, string> = {}) =>
    app.inject({ method, url: apiPath(url), payload, headers: { host: 'localhost', origin: PANEL, cookie: session, ...extra } });
  return { user, call };
}
type IsoUser = Awaited<ReturnType<typeof isoUser>>;
const draftBody = (groupIds: string[], extra: object = {}) => ({ name: 'Rascunho', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds, ...extra });
async function ownData(who: IsoUser, label: string) {
  const group = await who.call('POST', '/groups', { name: `Grupo ${label}` });
  assert.equal(group.statusCode, 201, group.body);
  const media = await who.call('POST', `/media?name=${label}.png`, await pngBytes(), { 'content-type': 'image/png' });
  assert.equal(media.statusCode, 201, media.body);
  const campaign = await who.call('POST', '/campaigns', { ...draftBody([group.json().id], { mediaId: media.json().id }), name: `Campanha ${label}` });
  assert.equal(campaign.statusCode, 201, campaign.body);
  return { groupId: group.json().id as string, mediaId: media.json().id as string, campaignId: campaign.json().id as string };
}
let isoWorldPromise: Promise<{ a: IsoUser; b: IsoUser; A: Awaited<ReturnType<typeof ownData>>; B: Awaited<ReturnType<typeof ownData>> }> | undefined;
const isoWorld = () => isoWorldPromise ??= (async () => {
  const a = await isoUser('iso-a@teste.local');
  const b = await isoUser('iso-b@teste.local');
  const A = await ownData(a, 'A');
  const B = await ownData(b, 'B');
  // A campanha de B fica ativa (simulação): passa a ter envios e histórico.
  const on = await b.call('PATCH', `/campaigns/${B.campaignId}/status`, { status: 'ACTIVE', provider: 'simulator' });
  assert.equal(on.statusCode, 200, on.body);
  return { a, b, A, B };
})();
const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort();
const withoutClock = (dashboard: Record<string, unknown>) => { const { serverNow: _ignored, ...rest } = dashboard; return rest; };

test('isolation: each user lists only their own campaigns, groups and deliveries', async () => {
  const { a, b, A, B } = await isoWorld();
  assert.deepEqual(ids((await a.call('GET', '/campaigns')).json()), [A.campaignId], '1. A lista só as campanhas de A');
  assert.deepEqual(ids((await b.call('GET', '/campaigns')).json()), [B.campaignId], '2. B lista só as campanhas de B');
  assert.deepEqual(ids((await a.call('GET', '/groups')).json()), [A.groupId]);
  assert.deepEqual(ids((await b.call('GET', '/groups')).json()), [B.groupId]);
  const historyB = (await b.call('GET', '/deliveries')).json() as { campaignId: string }[];
  assert.ok(historyB.length > 0 && historyB.every(d => d.campaignId === B.campaignId), 'B vê o próprio histórico');
  assert.deepEqual((await a.call('GET', '/deliveries')).json(), [], '10. histórico de A não mostra B');
  assert.deepEqual((await a.call('GET', `/deliveries?campaignId=${B.campaignId}`)).json(), [], 'nem filtrando pelo id da campanha de B');
  assert.deepEqual((await a.call('GET', `/deliveries?campaignId=${B.campaignId}&status=PENDING`)).json(), []);
});

test('isolation (IDOR): A cannot open, edit, delete or change the status of B\'s campaign; same answer as a nonexistent id', async () => {
  const { a, b, A, B } = await isoWorld();
  const before = await prisma.campaign.findUniqueOrThrow({ where: { id: B.campaignId }, include: { groups: true, messages: true } });
  const attempts: [Method, (id: string) => string, object?][] = [
    ['GET', id => `/campaigns/${id}`],
    ['PATCH', id => `/campaigns/${id}`, draftBody([A.groupId])],
    ['DELETE', id => `/campaigns/${id}`],
    ['PATCH', id => `/campaigns/${id}/status`, { status: 'PAUSED' }],
    ['PATCH', id => `/campaigns/${id}/status`, { status: 'CANCELLED' }],
    ['PATCH', id => `/campaigns/${id}/status`, { status: 'ACTIVE', provider: 'simulator' }],
  ];
  for (const [method, url, payload] of attempts) {
    const foreign = await a.call(method, url(B.campaignId), payload);
    const missing = await a.call(method, url('campanha-que-nao-existe'), payload);
    assert.equal(foreign.statusCode, 404, `${method} ${url('B')}: ${foreign.body}`);
    assert.equal(foreign.body, missing.body, `${method} ${url('B')}: resposta igual à de um id inexistente`);
  }
  const after = await prisma.campaign.findUniqueOrThrow({ where: { id: B.campaignId }, include: { groups: true, messages: true } });
  assert.deepEqual([after.status, after.name, after.deletedAt, after.groups.map(g => g.groupId), after.messages.map(m => m.content)], [before.status, before.name, before.deletedAt, before.groups.map(g => g.groupId), before.messages.map(m => m.content)], 'a campanha de B não mudou');
  assert.equal((await b.call('GET', `/campaigns/${B.campaignId}`)).statusCode, 200, 'B continua abrindo a sua');
});

test('isolation (IDOR): A cannot use B\'s group or media, nor download B\'s media', async () => {
  const { a, A, B } = await isoWorld();
  assert.equal((await a.call('POST', '/campaigns', draftBody([B.groupId]))).statusCode, 400, '7. grupo de B numa campanha nova');
  assert.equal((await a.call('POST', '/campaigns', draftBody([A.groupId], { mediaId: B.mediaId }))).statusCode, 400, '8. mídia de B numa campanha nova');
  assert.equal((await a.call('PATCH', `/campaigns/${A.campaignId}`, draftBody([B.groupId]))).statusCode, 400, 'grupo de B na edição');
  assert.equal((await a.call('PATCH', `/campaigns/${A.campaignId}`, draftBody([A.groupId], { mediaId: B.mediaId }))).statusCode, 400, 'mídia de B na edição');
  const foreign = await a.call('GET', `/media/${B.mediaId}`);
  const missing = await a.call('GET', '/media/midia-que-nao-existe');
  assert.equal(foreign.statusCode, 404, '9. A não baixa a mídia de B');
  assert.equal(foreign.body, missing.body);
  assert.equal((await a.call('GET', `/media/${B.mediaId}`, undefined, { range: 'bytes=0-10' })).statusCode, 404, 'nem por pedaço');
  assert.equal((await a.call('GET', `/media/${A.mediaId}`)).statusCode, 200, 'a própria mídia continua acessível');
  const mine = await prisma.campaign.findUniqueOrThrow({ where: { id: A.campaignId }, include: { groups: true } });
  assert.deepEqual([mine.mediaId, mine.groups.map(g => g.groupId)], [A.mediaId, [A.groupId]], 'a campanha de A continua só com dados de A');
});

test('isolation: the dashboard and campaign metrics count only the logged-in user', async () => {
  const { a, b, A, B } = await isoWorld();
  const dashboardA = withoutClock((await a.call('GET', '/dashboard')).json());
  const dashboardB = withoutClock((await b.call('GET', '/dashboard')).json());
  // Atividade real de B hoje: um envio pelo WhatsApp e três leituras.
  const [delivery] = await prisma.delivery.findMany({ where: { campaignId: B.campaignId }, take: 1 });
  await prisma.delivery.update({ where: { id: delivery.id }, data: { provider: 'baileys', status: 'SENT', sentAt: new Date(), providerId: '3EB0ISOB' } });
  for (const r of ['r1', 'r2', 'r3']) await prisma.deliveryRead.create({ data: { deliveryId: delivery.id, recipientHash: `${delivery.id}-${r}`, readAt: new Date() } });
  assert.deepEqual(withoutClock((await a.call('GET', '/dashboard')).json()), dashboardA, '11. o painel de A não conta nada de B');
  const nowB = (await b.call('GET', '/dashboard')).json();
  assert.equal(nowB.sentToday, (dashboardB.sentToday as number) + 1, 'o painel de B conta o envio de B');
  assert.equal(nowB.readsToday, (dashboardB.readsToday as number) + 3);
  assert.deepEqual(nowB.runningCampaigns.map((c: { id: string }) => c.id), [B.campaignId]);
  assert.ok(nowB.recentActivity.every((e: { campaignId: string }) => e.campaignId === B.campaignId));
  // 12. Leituras de B aparecem só para B.
  assert.equal((await b.call('GET', `/campaigns/${B.campaignId}`)).json().readsTotal, 3);
  assert.equal((await a.call('GET', `/campaigns/${A.campaignId}`)).json().readsTotal, 0);
  assert.equal((await a.call('GET', `/campaigns/${B.campaignId}`)).statusCode, 404);
  assert.deepEqual((await a.call('GET', '/deliveries?status=SENT')).json(), []);
});

test('isolation: the same WhatsApp group can exist for A and B, each sees only their own row', async () => {
  const { a, b } = await isoWorld();
  const jid = `120366${Date.now()}@g.us`;
  const rowA = await prisma.group.create({ data: { name: 'Mesmo grupo', externalId: jid, userId: a.user.id } });
  const rowB = await prisma.group.create({ data: { name: 'Mesmo grupo', externalId: jid, userId: b.user.id } });
  const seenByA = (await a.call('GET', '/groups')).json() as { id: string; externalId: string }[];
  const seenByB = (await b.call('GET', '/groups')).json() as { id: string; externalId: string }[];
  assert.deepEqual(seenByA.filter(g => g.externalId === jid).map(g => g.id), [rowA.id], '13. A vê a linha dele');
  assert.deepEqual(seenByB.filter(g => g.externalId === jid).map(g => g.id), [rowB.id], 'B vê a linha dele');
  assert.equal((await a.call('POST', '/campaigns', draftBody([rowB.id]))).statusCode, 400, 'e não usa a linha de B');
});

test('isolation: SUPER_ADMIN sees only their own data on the normal routes', async () => {
  const { A, B } = await isoWorld();
  const admin = await isoUser('iso-super@teste.local', 'SUPER_ADMIN');
  const own = await ownData(admin, 'S');
  assert.deepEqual(ids((await admin.call('GET', '/campaigns')).json()), [own.campaignId], '14. só as campanhas dele');
  assert.deepEqual(ids((await admin.call('GET', '/groups')).json()), [own.groupId]);
  assert.deepEqual((await admin.call('GET', '/deliveries')).json(), []);
  const dashboard = (await admin.call('GET', '/dashboard')).json();
  assert.equal(dashboard.activeCampaigns, 0, 'a campanha ativa de B não conta para o SUPER_ADMIN');
  assert.equal(dashboard.sentToday, 0);
  for (const url of [`/campaigns/${B.campaignId}`, `/campaigns/${A.campaignId}`, `/media/${B.mediaId}`]) {
    assert.equal((await admin.call('GET', url)).statusCode, 404, `SUPER_ADMIN não abre ${url} pelas rotas normais`);
  }
  assert.equal((await admin.call('PATCH', `/campaigns/${B.campaignId}/status`, { status: 'PAUSED' })).statusCode, 404);
});

test('isolation: userId in body, query or headers never widens or changes the scope', async () => {
  const { a, b, A, B } = await isoWorld();
  const spoof = { 'x-user-id': b.user.id, 'x-owner-id': b.user.id, cookie: '' };
  const asA = (method: Method, url: string, payload?: object) => a.call(method, url, payload, { 'x-user-id': b.user.id, 'x-role': 'SUPER_ADMIN' });
  assert.deepEqual(ids((await asA('GET', `/campaigns?userId=${b.user.id}`)).json()), [A.campaignId], '15. query/cabeçalho ignorados');
  assert.deepEqual(ids((await asA('GET', `/groups?userId=${b.user.id}`)).json()), ids(await prisma.group.findMany({ where: { userId: a.user.id } })), 'só os grupos de A');
  assert.deepEqual((await asA('GET', `/deliveries?userId=${b.user.id}`)).json(), []);
  assert.deepEqual(withoutClock((await asA('GET', `/dashboard?userId=${b.user.id}`)).json()), withoutClock((await a.call('GET', '/dashboard')).json()));
  assert.equal((await asA('PATCH', `/campaigns/${B.campaignId}/status`, { status: 'PAUSED', userId: b.user.id })).statusCode, 404, 'corpo com userId de B não abre a campanha de B');
  assert.equal((await asA('GET', `/media/${B.mediaId}?userId=${b.user.id}`)).statusCode, 404);
  // Sem a sessão, nada: o escopo nunca vem de outro lugar.
  const anonymous = await app.inject({ method: 'GET', url: '/api/campaigns', headers: { host: 'localhost', ...spoof } });
  assert.equal(anonymous.statusCode, 401);
});

// ─── Conexão de WhatsApp por usuário (ADR-019, Fase 4A) ─────────────────────────
// Só o modelo e as regras do banco: o sistema continua usando a conexão global.
const waUser = async (email: string) => prisma.user.upsert({ where: { email }, update: {}, create: { email, name: email.split('@')[0], passwordHash: 'x' } });

test('whatsapp session (4A): one per user, and a paired number belongs to a single user', async () => {
  const a = await waUser('wa-a@teste.local');
  const b = await waUser('wa-b@teste.local');
  const first = await prisma.whatsAppSession.create({ data: { userId: a.id } });
  assert.deepEqual([first.accountJid, first.state, first.autoConnect, first.lastConnectedAt, first.lastError], [null, 'disconnected', true, null, null], 'começa desconectada, sem número');
  await assert.rejects(prisma.whatsAppSession.create({ data: { userId: a.id } }), (e: { code?: string }) => e.code === 'P2002', 'um usuário, uma conexão');
  // Antes do pareamento o número é nulo: vários nulos convivem.
  const second = await prisma.whatsAppSession.create({ data: { userId: b.id } });
  assert.equal(second.accountJid, null);
  assert.equal(await prisma.whatsAppSession.count({ where: { userId: { in: [a.id, b.id] }, accountJid: null } }), 2);
  // Depois do pareamento, o número é de um usuário só.
  const jid = `5511${Date.now()}@s.whatsapp.net`;
  await prisma.whatsAppSession.update({ where: { userId: a.id }, data: { accountJid: jid, state: 'connected', lastConnectedAt: new Date() } });
  await assert.rejects(prisma.whatsAppSession.update({ where: { userId: b.id }, data: { accountJid: jid } }), (e: { code?: string }) => e.code === 'P2002', 'mesmo número em dois usuários: recusado');
  await prisma.whatsAppSession.update({ where: { userId: b.id }, data: { accountJid: `5521${Date.now()}@s.whatsapp.net`, state: 'connected' } });
  assert.equal(await prisma.whatsAppSession.count({ where: { userId: { in: [a.id, b.id] }, state: 'connected' } }), 2, 'duas conexões independentes convivem');
});

test('whatsapp session (4A): stores no credentials, and goes away with the user', async () => {
  const columns = (await prisma.$queryRawUnsafe<{ COLUMN_NAME: string }[]>("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'WhatsAppSession'")).map(c => c.COLUMN_NAME).sort();
  assert.deepEqual(columns, ['accountJid', 'autoConnect', 'createdAt', 'id', 'lastConnectedAt', 'lastError', 'state', 'updatedAt', 'userId'], 'nenhuma coluna de QR, creds ou chave do Baileys');
  const temp = await prisma.user.create({ data: { email: `wa-temp-${Date.now()}@teste.local`, name: 'Temp', passwordHash: 'x' } });
  await prisma.whatsAppSession.create({ data: { userId: temp.id } });
  await prisma.user.delete({ where: { id: temp.id } }); // usuário sem dados pode ser apagado
  assert.equal(await prisma.whatsAppSession.count({ where: { userId: temp.id } }), 0, 'a linha da conexão vai junto');
});

test('migration (real MySQL): WhatsAppSession is created without touching any existing data', async () => {
  await withLegacyDatabase(async (db, apply, names) => {
    const target = '20260922200000_whatsapp_session';
    for (const name of names.slice(0, names.indexOf(target))) await apply(name);
    const x = (sql: string) => db.$executeRawUnsafe(sql);
    await x("INSERT INTO `User` (id, email, name, passwordHash, role, updatedAt) VALUES ('u-dono', 'dono@x', 'Dono', 'h', 'SUPER_ADMIN', NOW(3))");
    await x("INSERT INTO `Group` (id, userId, externalId, name, updatedAt) VALUES ('g1', 'u-dono', '1203001@g.us', 'Grupo', NOW(3))");
    await x("INSERT INTO `Campaign` (id, userId, name, startsAt, endsAt, status, provider, accountJid, mode, intervalSeconds, updatedAt) VALUES ('c1', 'u-dono', 'Campanha', NOW(3), NOW(3), 'ACTIVE', 'baileys', '5511@s.whatsapp.net', 'IMMEDIATE', 180, NOW(3))");
    await x("INSERT INTO `CampaignGroup` (campaignId, groupId, userId, position) VALUES ('c1', 'g1', 'u-dono', 0)");
    await x("INSERT INTO `Delivery` (id, campaignId, groupId, messageBody, scheduledAt, status, provider, sequence, updatedAt) VALUES ('d1', 'c1', 'g1', 'oi', NOW(3), 'SENT', 'baileys', 0, NOW(3))");
    await x("INSERT INTO `WhatsAppAccount` (id, nextAvailableAt, lastSendEndedAt, lastIntervalSeconds) VALUES ('5511@s.whatsapp.net', '2026-09-21 17:03:05.000', '2026-09-21 17:00:05.000', 180)");
    const tables = ['User', 'Group', 'Campaign', 'CampaignGroup', 'Delivery', 'WhatsAppAccount'];
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async t => [t, Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n)])));
    const before = await count();
    const paceBefore = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM `WhatsAppAccount`'));
    const campaignBefore = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM `Campaign`'));

    await apply(target);

    assert.deepEqual(await count(), before, 'nenhuma linha mudou de número');
    assert.equal(JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM `WhatsAppAccount`')), paceBefore, 'ritmo por número intacto');
    assert.equal(JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM `Campaign`')), campaignBefore, 'campanhas intactas');
    assert.equal(Number((await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM `WhatsAppSession`"))[0].n), 0, 'tabela nova nasce vazia');
    // As regras valem já no banco migrado.
    await db.$executeRawUnsafe("INSERT INTO `User` (id, email, name, passwordHash, updatedAt) VALUES ('u-b', 'b@x', 'B', 'h', NOW(3))");
    await db.$executeRawUnsafe("INSERT INTO `WhatsAppSession` (id, userId, updatedAt) VALUES ('s1', 'u-dono', NOW(3)), ('s2', 'u-b', NOW(3))");
    await assert.rejects(db.$executeRawUnsafe("INSERT INTO `WhatsAppSession` (id, userId, updatedAt) VALUES ('s3', 'u-dono', NOW(3))"), /Duplicate/, 'uma conexão por usuário');
    await db.$executeRawUnsafe("UPDATE `WhatsAppSession` SET accountJid = '5511@s.whatsapp.net' WHERE id = 's1'");
    await assert.rejects(db.$executeRawUnsafe("UPDATE `WhatsAppSession` SET accountJid = '5511@s.whatsapp.net' WHERE id = 's2'"), /Duplicate/, 'um número, um usuário');
    await assert.rejects(db.$executeRawUnsafe("INSERT INTO `WhatsAppSession` (id, userId, updatedAt) VALUES ('s4', 'nao-existe', NOW(3))"), /foreign key/i);
  });
});

// ─── Partida e ciclo de vida das conexões por usuário (ADR-020, Fase 4B) ────────
// Com dubles de provider: nenhum socket é aberto e nenhum arquivo de sessão real é tocado.
type FakeBehaviour = { paired?: boolean; failConnect?: string };
function managerFor(behaviour: Record<string, FakeBehaviour> = {}) {
  const sessionsBase = mkdtempSync(join(tmpdir(), 'wa-startup-'));
  mkdirSync(join(sessionsBase, 'whatsapp'), { recursive: true });
  writeFileSync(join(sessionsBase, 'whatsapp', 'creds.json'), '{"me":{"id":"legado@s.whatsapp.net"}}');
  const calls = new Map<string, string[]>();
  const manager = new WhatsAppManager({
    sessionsBase,
    createProvider: (ownerId, sessionDir) => {
      const how = behaviour[ownerId] ?? {};
      const state = { state: 'disconnected' as string, accountJid: undefined as string | undefined, error: undefined as string | undefined };
      calls.set(ownerId, []);
      return {
        ownerId, sessionDir,
        status: () => ({ ...state }),
        hasPairedSession: async () => how.paired ?? false,
        connect: async () => {
          calls.get(ownerId)!.push('connect');
          if (how.failConnect) throw new Error(how.failConnect);
          state.state = 'connected'; state.accountJid = `55${ownerId.slice(-6)}@s.whatsapp.net`;
          return { ...state };
        },
        disconnect: async () => { calls.get(ownerId)!.push('disconnect'); state.state = 'disconnected'; state.accountJid = undefined; return { ...state }; },
        stop: async () => { calls.get(ownerId)!.push('stop'); },
        sync: async () => { calls.get(ownerId)!.push('sync'); return { count: 0 }; },
        send: async () => ({ messageId: 'duble', context: '' }),
        flushReads: async () => undefined,
        flushDeliveryEvents: async () => undefined,
      };
    },
  });
  const legacyIntact = () => assert.equal(readFileSync(join(sessionsBase, 'whatsapp', 'creds.json'), 'utf8'), '{"me":{"id":"legado@s.whatsapp.net"}}', 'sessão legada intacta');
  return { manager, calls, sessionsBase, legacyIntact, cleanup: () => rmSync(sessionsBase, { recursive: true, force: true }) };
}
async function startupUser(email: string, options: { disabled?: boolean; autoConnect?: boolean } = {}) {
  const user = await prisma.user.upsert({
    where: { email },
    update: { disabledAt: options.disabled ? new Date() : null },
    create: { email, name: email.split('@')[0], passwordHash: 'x', disabledAt: options.disabled ? new Date() : null },
  });
  await prisma.whatsAppSession.upsert({ where: { userId: user.id }, update: { autoConnect: options.autoConnect ?? true, state: 'disconnected', accountJid: null, lastError: null }, create: { userId: user.id, autoConnect: options.autoConnect ?? true } });
  return user;
}

test('startup (4B): reconnects each eligible session on its own; one failure does not stop the others', async () => {
  const ok = await startupUser('start-ok@teste.local');
  const bad = await startupUser('start-bad@teste.local');
  const semSessao = await startupUser('start-nova@teste.local');
  const { manager, calls, legacyIntact, cleanup } = managerFor({
    [ok.id]: { paired: true },
    [bad.id]: { paired: true, failConnect: 'socket caiu' },
    [semSessao.id]: { paired: false },
  });
  try {
    const result = await manager.startAll({} as NodeJS.ProcessEnv);
    const outcome = (id: string) => result.find(r => r.userId === id)?.outcome;
    assert.equal(outcome(ok.id), 'conectando');
    assert.equal(outcome(bad.id), 'falhou', 'a falha de um fica registrada');
    assert.equal(outcome(semSessao.id), 'sem-sessao', 'quem nunca pareou não é conectado (nenhum QR automático)');
    assert.deepEqual(calls.get(semSessao.id), [], 'sem sessão pareada, nem tenta conectar');
    // O banco reflete o ciclo de vida, sem nada sensível.
    const connected = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: ok.id } });
    assert.equal(connected.state, 'connected');
    assert.ok(connected.accountJid?.endsWith('@s.whatsapp.net'));
    assert.ok(connected.lastConnectedAt, 'registra quando conectou');
    const failed = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: bad.id } });
    assert.equal(failed.state, 'error');
    assert.match(failed.lastError ?? '', /socket caiu/);
    assert.equal(failed.accountJid, null);
    assert.equal((await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: semSessao.id } })).state, 'disconnected');
    legacyIntact();
  } finally { await manager.stopAll(); cleanup(); }
});

test('startup (4B): skips disabled users, autoConnect=false and WHATSAPP_AUTO_CONNECT=0', async () => {
  const ativo = await startupUser('start-ativo@teste.local');
  const desativado = await startupUser('start-desativado@teste.local', { disabled: true });
  const semAuto = await startupUser('start-sem-auto@teste.local', { autoConnect: false });
  const { manager, calls, legacyIntact, cleanup } = managerFor({
    [ativo.id]: { paired: true }, [desativado.id]: { paired: true }, [semAuto.id]: { paired: true },
  });
  try {
    assert.deepEqual(await manager.startAll({ WHATSAPP_AUTO_CONNECT: '0' } as NodeJS.ProcessEnv), [], 'desligado por variável de ambiente');
    assert.deepEqual(manager.owners(), [], 'nem cria provider');
    const result = await manager.startAll({} as NodeJS.ProcessEnv);
    const meus = result.filter(r => [ativo.id, desativado.id, semAuto.id].includes(r.userId));
    assert.deepEqual(meus.map(r => r.userId), [ativo.id], 'só o usuário ativo com autoConnect');
    assert.equal(calls.get(desativado.id), undefined, 'usuário desativado não reconecta');
    assert.equal(calls.get(semAuto.id), undefined, 'autoConnect=false não reconecta');
    // Usuário desativado pode ter o provider parado sem perder a sessão nem as credenciais.
    const provider = manager.for(desativado.id);
    await manager.stop(desativado.id);
    assert.deepEqual(calls.get(desativado.id), ['stop'], 'stop, nunca disconnect/logout');
    assert.ok(provider.sessionDir.includes(desativado.id), 'cada um na sua pasta');
    legacyIntact();
  } finally { await manager.stopAll(); cleanup(); }
});

test('lifecycle (4B): session row keeps only lifecycle data; disconnect clears the paired number', async () => {
  const user = await startupUser('start-ciclo@teste.local');
  const outro = await startupUser('start-ciclo-2@teste.local');
  const { manager, calls, legacyIntact, cleanup } = managerFor({ [user.id]: { paired: true }, [outro.id]: { paired: true } });
  try {
    await manager.ensureSession(user.id);
    await manager.ensureSession(user.id); // idempotente
    assert.equal(await prisma.whatsAppSession.count({ where: { userId: user.id } }), 1);
    await manager.for(user.id).connect();
    await manager.persistState(user.id);
    const row = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } });
    assert.deepEqual(Object.keys(row).sort(), ['accountJid', 'autoConnect', 'createdAt', 'id', 'lastConnectedAt', 'lastError', 'state', 'updatedAt', 'userId'], 'nenhum campo de QR ou credencial');
    assert.equal(row.state, 'connected');
    // Número já pareado em outra conta: registra o motivo, sem quebrar a partida.
    await prisma.whatsAppSession.update({ where: { userId: user.id }, data: { accountJid: null } });
    await prisma.whatsAppSession.update({ where: { userId: outro.id }, data: { accountJid: row.accountJid } });
    await manager.persistState(user.id); // a conexão segue com o mesmo número
    const conflito = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(conflito.accountJid, null, 'não rouba o número do outro');
    assert.match(conflito.lastError ?? '', /já está conectado em outra conta/);
    // Desconectar de verdade limpa o número e sai do mapa.
    await manager.disconnect(user.id);
    assert.ok(calls.get(user.id)!.includes('disconnect'));
    assert.equal(manager.peek(user.id), undefined);
    assert.equal((await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } })).accountJid, null);
    legacyIntact();
  } finally { await manager.stopAll(); cleanup(); }
});

// ─── Rotas do WhatsApp por usuário (ADR-021, Fase 4C) ───────────────────────────
// App próprio: conexão global legada e gerenciador com pasta temporária. Nenhum socket é
// aberto e a sessão real do dono nunca entra nestes testes.
function whatsappApp(options: { legacyPaired?: boolean; legacyState?: string } = {}) {
  const sessionsBase = mkdtempSync(join(tmpdir(), 'wa-rotas-'));
  mkdirSync(join(sessionsBase, 'whatsapp'), { recursive: true });
  writeFileSync(join(sessionsBase, 'whatsapp', 'creds.json'), '{"me":{"id":"legado@s.whatsapp.net"}}');
  const legacyCalls: string[] = [];
  const legacy = {
    status: () => ({ state: options.legacyState ?? 'connected', accountJid: '5511LEGADO@s.whatsapp.net', qr: 'qr-da-sessao-legada' }),
    connect: async () => { legacyCalls.push('connect'); return { state: 'connected', accountJid: '5511LEGADO@s.whatsapp.net' }; },
    disconnect: async () => { legacyCalls.push('disconnect'); return { state: 'disconnected' }; },
    sync: async (ownerId: string) => { legacyCalls.push(`sync:${ownerId}`); return { count: 7 }; },
    hasPairedSession: async () => options.legacyPaired ?? true,
  };
  const perUser = new Map<string, { calls: string[]; state: { state: string; qr?: string; accountJid?: string } }>();
  const manager = new WhatsAppManager({
    sessionsBase,
    createProvider: (ownerId, sessionDir) => {
      const entry = { calls: [] as string[], state: { state: 'disconnected' as string, qr: undefined as string | undefined, accountJid: undefined as string | undefined } };
      perUser.set(ownerId, entry);
      return {
        ownerId, sessionDir,
        status: () => ({ ...entry.state }),
        hasPairedSession: async () => false,
        connect: async () => { entry.calls.push('connect'); entry.state = { state: 'qr', qr: `qr-de-${ownerId}`, accountJid: undefined }; return { ...entry.state }; },
        disconnect: async () => { entry.calls.push('disconnect'); entry.state = { state: 'disconnected', qr: undefined, accountJid: undefined }; return { ...entry.state }; },
        stop: async () => { entry.calls.push('stop'); },
        sync: async (owner: string) => { entry.calls.push(`sync:${owner}`); return { count: 3 }; },
        send: async () => ({ messageId: 'duble', context: '' }),
        flushReads: async () => undefined,
        flushDeliveryEvents: async () => undefined,
      };
    },
  });
  const instance = buildApp(legacy, loadConfig({}), manager);
  return { app: instance, manager, legacy, legacyCalls, perUser, sessionsBase, cleanup: async () => { await instance.close(); rmSync(sessionsBase, { recursive: true, force: true }); } };
}
async function sessionFor(instance: ReturnType<typeof buildApp>, email: string, role: 'USER' | 'SUPER_ADMIN' = 'USER') {
  await prisma.user.upsert({ where: { email }, update: { role, disabledAt: null }, create: { email, name: email.split('@')[0], role, passwordHash: await hashPassword('senha-de-teste-123') } });
  const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost', origin: PANEL }, payload: { email, password: 'senha-de-teste-123' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const user = login.json().user as { id: string };
  const call = (method: 'GET' | 'POST', path: string, payload?: object, extra: Record<string, string> = {}) =>
    instance.inject({ method, url: `/api/whatsapp/${path}`, payload, headers: { host: 'localhost', origin: PANEL, cookie, ...extra } });
  return { user, call };
}
/** Deixa apenas este usuário como SUPER_ADMIN ativo (a ponte legada exige dono inequívoco). */
async function onlySuperAdmin(userId: string) {
  const previous = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', disabledAt: null, NOT: { id: userId } }, select: { id: true } });
  await prisma.user.updateMany({ where: { id: { in: previous.map(u => u.id) } }, data: { role: 'USER' } });
  return async () => { await prisma.user.updateMany({ where: { id: { in: previous.map(u => u.id) } }, data: { role: 'SUPER_ADMIN' } }); };
}

test('whatsapp routes (4C): status, QR, connect, disconnect and sync are isolated per user', async () => {
  const world = whatsappApp();
  try {
    const a = await sessionFor(world.app, 'rota-a@teste.local');
    const b = await sessionFor(world.app, 'rota-b@teste.local');
    // Usuário sem conexão: estado próprio, vazio.
    assert.deepEqual((await a.call('GET', 'status')).json(), { state: 'disconnected' });
    // A conecta: o QR é só dele e vem da memória do provider dele.
    assert.equal((await a.call('POST', 'connect')).json().qr, `qr-de-${a.user.id}`);
    assert.deepEqual((await b.call('GET', 'status')).json(), { state: 'disconnected' }, 'B não vê o QR nem o estado de A');
    assert.equal((await a.call('GET', 'status')).json().qr, `qr-de-${a.user.id}`);
    assert.deepEqual(world.perUser.get(b.user.id)?.calls ?? [], [], 'nada foi chamado no provider de B');
    // Sincronizar usa o provider e o dono de quem pediu.
    assert.equal((await b.call('POST', 'sync')).json().count, 3);
    assert.deepEqual(world.perUser.get(b.user.id)!.calls, ['sync:' + b.user.id]);
    assert.ok(!world.perUser.get(a.user.id)!.calls.includes(`sync:${b.user.id}`));
    // Desconectar A não encosta em B.
    await b.call('POST', 'connect');
    await a.call('POST', 'disconnect');
    assert.deepEqual(world.perUser.get(a.user.id)!.calls, ['connect', 'disconnect']);
    assert.equal(world.perUser.get(b.user.id)!.state.state, 'qr', 'a conexão de B continua de pé');
    assert.equal((await b.call('GET', 'status')).json().qr, `qr-de-${b.user.id}`);
    // Nenhum deles tocou na conexão global legada.
    assert.deepEqual(world.legacyCalls, []);
  } finally { await world.cleanup(); }
});

test('whatsapp routes (4C): userId in body, query or headers never changes whose connection is used', async () => {
  const world = whatsappApp();
  try {
    const a = await sessionFor(world.app, 'rota-spoof-a@teste.local');
    const b = await sessionFor(world.app, 'rota-spoof-b@teste.local');
    await b.call('POST', 'connect');
    const spoof = { 'x-user-id': b.user.id, 'x-role': 'SUPER_ADMIN' };
    assert.deepEqual((await a.call('GET', `status?userId=${b.user.id}`, undefined, spoof)).json(), { state: 'disconnected' }, 'continua sendo a conexão de A');
    await a.call('POST', `connect?userId=${b.user.id}`, { userId: b.user.id }, spoof);
    assert.equal((await a.call('GET', 'status')).json().qr, `qr-de-${a.user.id}`);
    await a.call('POST', 'disconnect', { userId: b.user.id }, spoof);
    assert.deepEqual(world.perUser.get(b.user.id)!.calls, ['connect'], 'B não foi desconectado nem sincronizado');
    await a.call('POST', 'sync', { userId: b.user.id }, spoof);
    assert.deepEqual(world.perUser.get(a.user.id)!.calls.filter(c => c.startsWith('sync')), [`sync:${a.user.id}`]);
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/whatsapp/status', headers: { host: 'localhost', ...spoof } })).statusCode, 401, 'sem sessão, nada');
  } finally { await world.cleanup(); }
});

test('legacy bridge (4C): only the single active SUPER_ADMIN reaches the global session', async () => {
  const world = whatsappApp();
  try {
    const admin = await sessionFor(world.app, 'rota-admin@teste.local', 'SUPER_ADMIN');
    const user = await sessionFor(world.app, 'rota-user@teste.local');
    // Com mais de um SUPER_ADMIN ativo o dono é ambíguo: ninguém recebe a sessão legada.
    assert.deepEqual((await admin.call('GET', 'status')).json(), { state: 'disconnected' }, 'dono ambíguo: conexão própria, vazia');
    const restore = await onlySuperAdmin(admin.user.id);
    try {
      const status = (await admin.call('GET', 'status')).json();
      assert.equal(status.accountJid, '5511LEGADO@s.whatsapp.net', 'o dono inequívoco continua vendo a sessão legada');
      // USER comum JAMAIS recebe a sessão global, nem forçando ids.
      assert.deepEqual((await user.call('GET', 'status', undefined, { 'x-user-id': admin.user.id })).json(), { state: 'disconnected' });
      assert.equal((await user.call('POST', 'sync')).json().count, 3, 'USER sincroniza pelo provider dele');
      assert.deepEqual(world.legacyCalls, [], 'o USER não encostou na conexão global');
      // O SUPER_ADMIN opera a legada: sincronizar e conectar vão para ela, com o dono certo.
      assert.equal((await admin.call('POST', 'sync')).json().count, 7);
      assert.deepEqual(world.legacyCalls, [`sync:${admin.user.id}`]);
      // Assim que existir pasta própria (4E), a ponte se desliga sozinha.
      mkdirSync(world.manager.sessionDirFor(admin.user.id), { recursive: true });
      assert.deepEqual((await admin.call('GET', 'status')).json(), { state: 'disconnected' }, 'com pasta própria, a ponte sai de cena');
      rmSync(world.manager.sessionDirFor(admin.user.id), { recursive: true, force: true });
      // LEGACY_SESSION_OWNER apontando para outra pessoa também desliga a ponte para ele.
      process.env.LEGACY_SESSION_OWNER = user.user.id;
      try {
        assert.deepEqual((await admin.call('GET', 'status')).json(), { state: 'disconnected' });
        assert.deepEqual((await user.call('GET', 'status')).json(), { state: 'disconnected' }, 'declarar um USER não lhe dá a sessão global');
      } finally { delete process.env.LEGACY_SESSION_OWNER; }
    } finally { await restore(); }
  } finally { await world.cleanup(); }
});

test('legacy bridge (4C): without a paired global session nobody gets the bridge', async () => {
  const world = whatsappApp({ legacyPaired: false });
  try {
    const admin = await sessionFor(world.app, 'rota-admin-sem-sessao@teste.local', 'SUPER_ADMIN');
    const restore = await onlySuperAdmin(admin.user.id);
    try {
      assert.deepEqual((await admin.call('GET', 'status')).json(), { state: 'disconnected' }, 'sem sessão legada pareada, conexão própria');
      await admin.call('POST', 'connect');
      assert.deepEqual(world.legacyCalls, [], 'a conexão global não é usada');
      assert.equal(world.perUser.get(admin.user.id)!.calls[0], 'connect');
    } finally { await restore(); }
  } finally { await world.cleanup(); }
});

test('whatsapp routes (4C): a disabled user cannot reach any connection', async () => {
  const world = whatsappApp();
  try {
    const user = await sessionFor(world.app, 'rota-desativado@teste.local');
    await user.call('POST', 'connect');
    await prisma.user.update({ where: { id: user.user.id }, data: { disabledAt: new Date() } });
    for (const [method, path] of [['GET', 'status'], ['POST', 'connect'], ['POST', 'disconnect'], ['POST', 'sync']] as const) {
      assert.equal((await user.call(method, path)).statusCode, 401, `${path}: sessão derrubada`);
    }
    await prisma.user.update({ where: { id: user.user.id }, data: { disabledAt: null } });
  } finally { await world.cleanup(); }
});

test('whatsapp routes (4C): real campaigns keep using the old global path', async () => {
  const world = whatsappApp();
  try {
    const admin = await sessionFor(world.app, 'rota-campanha@teste.local', 'SUPER_ADMIN');
    const restore = await onlySuperAdmin(admin.user.id);
    try {
      const group = await prisma.group.create({ data: { name: 'Grupo da campanha', externalId: `120355${Date.now()}@g.us`, userId: admin.user.id } });
      const campaign = await prisma.campaign.create({ data: { name: 'Campanha real', userId: admin.user.id, startsAt: new Date(), endsAt: new Date(), mode: 'IMMEDIATE', intervalSeconds: 180, messages: { create: [{ content: 'oi', position: 0 }] }, groups: { create: [{ groupId: group.id, position: 0 }] } } });
      const activate = await world.app.inject({ method: 'PATCH', url: `/api/campaigns/${campaign.id}/status`, payload: { status: 'ACTIVE', provider: 'baileys', consent: true }, headers: { host: 'localhost', origin: PANEL, cookie: (await loginAs(world.app, 'rota-campanha@teste.local')).cookie } });
      assert.equal(activate.statusCode, 200, activate.body);
      const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      assert.equal(saved.accountJid, '5511LEGADO@s.whatsapp.net', 'a campanha real continua saindo pelo número da conexão global');
      assert.deepEqual(world.perUser.get(admin.user.id)?.calls ?? [], [], 'o provider novo não foi usado pelo envio');
    } finally { await restore(); }
  } finally { await world.cleanup(); }
});

// ─── Envio, eventos e recibos com dono inequívoco (ADR-022, Fase 4D) ────────────
// Dubles e pastas temporárias: a sessão real nunca entra aqui.
const JID_A = '5511000000A0@s.whatsapp.net';
const JID_B = '5511000000B0@s.whatsapp.net';
const JID_LEGADO = '5511LEGADO00@s.whatsapp.net';

function sendingWorld() {
  const sessionsBase = mkdtempSync(join(tmpdir(), 'wa-envio-'));
  mkdirSync(join(sessionsBase, 'whatsapp'), { recursive: true });
  writeFileSync(join(sessionsBase, 'whatsapp', 'creds.json'), '{"me":{"id":"legado@s.whatsapp.net"}}');
  type Sent = { jid: string; accountJid: string | null; groupId?: string };
  const make = (jid: string | null, extras: { ownerId?: string; sessionDir?: string } = {}) => {
    const sent: Sent[] = [];
    let state = jid ? 'connected' : 'disconnected';
    return {
      sent,
      setState: (next: string) => { state = next; },
      provider: {
        ownerId: extras.ownerId ?? null, sessionDir: extras.sessionDir ?? sessionsBase,
        status: () => ({ state, ...(jid ? { accountJid: jid } : {}) }),
        hasPairedSession: async () => Boolean(jid),
        connect: async () => ({ state }), disconnect: async () => ({ state: 'disconnected' }), stop: async () => undefined,
        sync: async () => ({ count: 0 }),
        flushReads: async () => undefined, flushDeliveryEvents: async () => undefined,
        // Mesma regra do conector real: o número da campanha precisa bater com o conectado.
        send: async (groupJid: string, _text: string, accountJid: string | null, _media?: unknown, groupId?: string) => {
          if (accountJid !== jid) throw notSentError('Número conectado difere do número da campanha.');
          sent.push({ jid: groupJid, accountJid, groupId });
          return { messageId: `3EB0${sent.length}${groupJid.slice(6, 12)}`, context: 'membro=sim admin=nao so-admins=nao participantes=4' };
        },
      },
    };
  };
  const fakes = new Map<string, ReturnType<typeof make>>();
  const numbers = new Map<string, string | null>();
  const manager = new WhatsAppManager({
    sessionsBase,
    createProvider: (ownerId, sessionDir) => {
      const fake = make(numbers.get(ownerId) ?? null, { ownerId, sessionDir });
      fakes.set(ownerId, fake);
      return fake.provider;
    },
  });
  const legacy = make(JID_LEGADO);
  const router = createSendingRouter<ManagedProvider>({ manager, legacyProvider: legacy.provider as unknown as ManagedProvider & { hasPairedSession(): Promise<boolean> } });
  return {
    manager, router, legacy, fakes, sessionsBase,
    /** Cria a conexão daquele usuário com um número (ou desconectada, se number = null). */
    connect(userId: string, number: string | null) { numbers.set(userId, number); manager.for(userId); return fakes.get(userId)!; },
    legacyIntact: () => assert.equal(readFileSync(join(sessionsBase, 'whatsapp', 'creds.json'), 'utf8'), '{"me":{"id":"legado@s.whatsapp.net"}}'),
    cleanup: () => rmSync(sessionsBase, { recursive: true, force: true }),
  };
}
const notSentError = (message: string) => Object.assign(new Error(message), { notSent: true });

let sendingSeq = 0;
/** Campanha ativa de um usuário, com um grupo por envio. */
async function ownedCampaign(userId: string, accountJid: string | null, groupCount = 1, intervalSeconds = 1) {
  const now = new Date(Date.now() - 1000);
  const groups = [];
  for (let i = 0; i < groupCount; i++) groups.push(await prisma.group.create({ data: { name: `Envio ${sendingSeq}.${i}`, userId, externalId: `120344${Date.now()}${sendingSeq++}@g.us` } }));
  const campaign = await prisma.campaign.create({ data: {
    name: `Campanha ${sendingSeq}`, userId, startsAt: now, endsAt: now, status: 'ACTIVE', provider: 'baileys', accountJid, mode: 'IMMEDIATE', intervalSeconds, nextAvailableAt: now,
    groups: { create: groups.map((g, position) => ({ groupId: g.id, position })) },
    messages: { create: [{ content: 'oi', position: 0 }] },
    deliveries: { create: groups.map((g, sequence) => ({ groupId: g.id, messageBody: 'oi', provider: 'baileys', sequence, scheduledAt: new Date(now.getTime() + sequence * intervalSeconds * 1000) })) },
  } });
  const rows = await prisma.delivery.findMany({ where: { campaignId: campaign.id }, orderBy: { sequence: 'asc' }, include: { group: true } });
  return { campaign, rows, groups };
}
const pauseEverything = () => prisma.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });
async function owners() {
  const passwordHash = await hashPassword('senha-de-teste-123');
  const a = await prisma.user.upsert({ where: { email: 'envio-a@teste.local' }, update: { role: 'USER', disabledAt: null }, create: { email: 'envio-a@teste.local', name: 'Envio A', passwordHash } });
  const b = await prisma.user.upsert({ where: { email: 'envio-b@teste.local' }, update: { role: 'USER', disabledAt: null }, create: { email: 'envio-b@teste.local', name: 'Envio B', passwordHash } });
  return { a, b };
}

test('sending (4D): each campaign goes out through its own owner connection, never the other', async () => {
  const { a, b } = await owners();
  await pauseEverything();
  const world = sendingWorld();
  try {
    world.connect(a.id, JID_A);
    world.connect(b.id, JID_B);
    const campaignA = await ownedCampaign(a.id, JID_A, 2);
    const campaignB = await ownedCampaign(b.id, JID_B, 2);
    const dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await waitFor(async () => (await prisma.delivery.findMany({ where: { campaignId: { in: [campaignA.campaign.id, campaignB.campaign.id] } } })).every(d => d.status === 'SENT'), 'as duas campanhas enviadas', 30_000);
    } finally { await dispatcher.stop(); }
    const gruposA = campaignA.groups.map(g => g.externalId);
    const gruposB = campaignB.groups.map(g => g.externalId);
    assert.deepEqual(world.fakes.get(a.id)!.sent.map(s => s.jid).sort(), [...gruposA].sort(), 'A enviou só para os grupos de A');
    assert.deepEqual(world.fakes.get(b.id)!.sent.map(s => s.jid).sort(), [...gruposB].sort(), 'B enviou só para os grupos de B');
    assert.ok(world.fakes.get(a.id)!.sent.every(s => s.accountJid === JID_A));
    assert.ok(world.fakes.get(b.id)!.sent.every(s => s.accountJid === JID_B));
    assert.deepEqual(world.legacy.sent, [], 'a sessão legada não foi usada por ninguém');
    // O selo do grupo é atualizado pelo id exato da entrega.
    assert.ok(world.fakes.get(a.id)!.sent.every(s => campaignA.groups.some(g => g.id === s.groupId)));
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('sending (4D): with the owner disconnected the campaign waits; it never borrows another number', async () => {
  const { a, b } = await owners();
  await pauseEverything();
  const world = sendingWorld();
  try {
    world.connect(a.id, null); // A tem conexão, mas desconectada
    world.connect(b.id, JID_B);
    const campaignA = await ownedCampaign(a.id, JID_A);
    const campaignB = await ownedCampaign(b.id, JID_B);
    const dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await waitFor(async () => (await fresh(campaignB.rows[0].id)).status === 'SENT', 'B enviou');
      await sleep(400);
      const parado = await fresh(campaignA.rows[0].id);
      assert.equal(parado.status, 'PENDING', 'A continua esperando a própria conexão');
      assert.equal(parado.sentAt, null, 'nunca marcado como enviado sem envio');
      assert.deepEqual([...world.fakes.get(a.id)!.sent], []);
      assert.ok(world.fakes.get(b.id)!.sent.every(s => s.jid !== campaignA.groups[0].externalId), 'B não enviou nada de A');
      assert.deepEqual([...world.legacy.sent], []);
    } finally { await dispatcher.stop(); }
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('sending (4D): negative case — with only a connected legacy session, a USER campaign does NOT send', async () => {
  const { a } = await owners();
  await pauseEverything();
  const world = sendingWorld();
  try {
    // Cenário armado para errar: o USER não tem conexão nenhuma e a legada está conectada.
    const campaignA = await ownedCampaign(a.id, JID_A);
    const admin = await prisma.user.upsert({ where: { email: 'envio-admin@teste.local' }, update: { role: 'SUPER_ADMIN', disabledAt: null }, create: { email: 'envio-admin@teste.local', name: 'Admin', role: 'SUPER_ADMIN', passwordHash: await hashPassword('senha-de-teste-123') } });
    const restore = await onlySuperAdmin(admin.id); // ponte válida, mas para o ADMIN, não para o USER
    const dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await sleep(600);
      const parado = await fresh(campaignA.rows[0].id);
      assert.equal(parado.status, 'PENDING', 'prefere NÃO ENVIAR a enviar pelo número errado');
      assert.equal(parado.attempts, 0, 'nem chegou a tentar');
      assert.deepEqual(world.legacy.sent, [], 'a sessão legada não virou fallback do USER');
    } finally { await dispatcher.stop(); await restore(); }
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('sending (4D): the proven owner of the legacy session still sends through it; ambiguity stops it', async () => {
  await pauseEverything();
  const world = sendingWorld();
  const admin = await prisma.user.upsert({ where: { email: 'envio-admin@teste.local' }, update: { role: 'SUPER_ADMIN', disabledAt: null }, create: { email: 'envio-admin@teste.local', name: 'Admin', role: 'SUPER_ADMIN', passwordHash: await hashPassword('senha-de-teste-123') } });
  try {
    const campaign = await ownedCampaign(admin.id, JID_LEGADO);
    // 1) Dono ambíguo (vários SUPER_ADMIN ativos): não envia.
    const outro = await prisma.user.upsert({ where: { email: 'envio-admin-2@teste.local' }, update: { role: 'SUPER_ADMIN', disabledAt: null }, create: { email: 'envio-admin-2@teste.local', name: 'Admin 2', role: 'SUPER_ADMIN', passwordHash: await hashPassword('senha-de-teste-123') } });
    let dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await sleep(500);
      assert.equal((await fresh(campaign.rows[0].id)).status, 'PENDING', 'ponte inválida: não usa o provider global');
      assert.deepEqual([...world.legacy.sent], []);
    } finally { await dispatcher.stop(); }
    // 2) Dono inequívoco: a campanha dele continua saindo pela sessão legada (até a 4E).
    const restore = await onlySuperAdmin(admin.id);
    dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await waitFor(async () => (await fresh(campaign.rows[0].id)).status === 'SENT', 'envio pela sessão legada');
      assert.deepEqual(world.legacy.sent.map(s => s.jid), [campaign.groups[0].externalId]);
      assert.equal(world.legacy.sent[0].accountJid, JID_LEGADO);
    } finally { await dispatcher.stop(); await restore(); await prisma.user.update({ where: { id: outro.id }, data: { role: 'USER' } }); }
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('sending (4D): a number that does not match the campaign blocks the send', async () => {
  const { a } = await owners();
  await pauseEverything();
  const world = sendingWorld();
  try {
    world.connect(a.id, JID_B); // conectado, mas com OUTRO número
    const campaign = await ownedCampaign(a.id, JID_A);
    const dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      const row = await waitFor(async () => { const d = await fresh(campaign.rows[0].id); return d.attempts > 0 && d; }, 'tentativa registrada');
      assert.notEqual(row.status, 'SENT', 'número incompatível não vira envio');
      assert.match(row.error ?? '', /Número conectado difere/);
      assert.deepEqual(world.fakes.get(a.id)!.sent, [], 'nada saiu');
    } finally { await dispatcher.stop(); }
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('sending (4D): after a restart the campaign still uses its own owner connection', async () => {
  const { a, b } = await owners();
  await pauseEverything();
  const world = sendingWorld();
  try {
    world.connect(b.id, JID_B); // B conecta primeiro: não pode virar o provider de A
    const campaignA = await ownedCampaign(a.id, JID_A);
    let dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try { await sleep(300); assert.equal((await fresh(campaignA.rows[0].id)).status, 'PENDING'); }
    finally { await dispatcher.stop(); }
    // "Reinício": A conecta agora e o envio dele sai pela conexão dele.
    world.connect(a.id, JID_A);
    dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await waitFor(async () => (await fresh(campaignA.rows[0].id)).status === 'SENT', 'envio após reinício');
      assert.deepEqual(world.fakes.get(a.id)!.sent.map(s => s.jid), [campaignA.groups[0].externalId]);
      assert.ok(world.fakes.get(b.id)!.sent.every(s => s.jid !== campaignA.groups[0].externalId));
    } finally { await dispatcher.stop(); }
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('events (4D): a receipt or refusal from one owner never touches another owner delivery', async () => {
  const { a, b } = await owners();
  await pauseEverything();
  // Mesmo grupo (mesmo externalId) e MESMO id de mensagem nos dois donos: o pior caso.
  const jidGrupo = `120388${Date.now()}@g.us`;
  const messageId = '3EB0MESMOID';
  const build = async (userId: string, accountJid: string) => {
    const group = await prisma.group.create({ data: { name: 'Mesmo grupo', userId, externalId: jidGrupo } });
    const campaign = await prisma.campaign.create({ data: {
      name: 'Eventos', userId, startsAt: new Date(), endsAt: new Date(), status: 'ACTIVE', provider: 'baileys', accountJid, mode: 'IMMEDIATE', intervalSeconds: 60,
      groups: { create: [{ groupId: group.id, position: 0 }] }, messages: { create: [{ content: 'oi', position: 0 }] },
      deliveries: { create: [{ groupId: group.id, messageBody: 'oi', provider: 'baileys', sequence: 0, status: 'SENT', providerId: messageId, sentAt: new Date(), scheduledAt: new Date() }] },
    } });
    const [delivery] = await prisma.delivery.findMany({ where: { campaignId: campaign.id } });
    return { group, campaign, delivery };
  };
  const ladoA = await build(a.id, JID_A);
  const ladoB = await build(b.id, JID_B);
  // Entrega chegando pela conexão de A: só a entrega de A muda.
  assert.equal(await applyServerEvent(prisma, { kind: 'delivered', messageId, groupJid: jidGrupo, accountJid: JID_A, at: new Date(), ownerId: a.id }), true);
  assert.ok((await fresh(ladoA.delivery.id)).deliveredAt, 'A recebeu a confirmação');
  assert.equal((await fresh(ladoB.delivery.id)).deliveredAt, null, 'B não foi tocado');
  // Recusa pela conexão de B: só a entrega de B muda.
  assert.equal(await applyServerEvent(prisma, { kind: 'rejected', messageId, groupJid: jidGrupo, accountJid: JID_B, at: new Date(), code: '479', ownerId: b.id }), true);
  assert.equal((await fresh(ladoB.delivery.id)).errorCode, 'servidor:479');
  assert.equal((await fresh(ladoA.delivery.id)).errorCode, null, 'a recusa de B não marcou a entrega de A');
  // Leitura pela conexão de A: a contagem de B continua zero.
  await persistRead(prisma, { messageId, groupJid: jidGrupo, accountJid: JID_A, participant: '5599@s.whatsapp.net', readAt: new Date(), ownerId: a.id });
  await flushPendingReads(prisma, { ownerId: b.id });
  assert.equal(await prisma.deliveryRead.count({ where: { deliveryId: ladoA.delivery.id } }), 0, 'o dono errado não aplica o recibo');
  await flushPendingReads(prisma, { ownerId: a.id });
  assert.equal(await prisma.deliveryRead.count({ where: { deliveryId: ladoA.delivery.id } }), 1);
  assert.equal(await prisma.deliveryRead.count({ where: { deliveryId: ladoB.delivery.id } }), 0, 'a leitura de A não conta para a campanha de B');
  assert.equal((await prisma.pendingRead.count({ where: { ownerId: a.id } })), 0, 'recibo aplicado sai da fila');
});

test('groups (4D): sending for one owner updates only that owner group row', async () => {
  const { a, b } = await owners();
  const jidGrupo = `120399${Date.now()}@g.us`;
  const grupoA = await prisma.group.create({ data: { name: 'Compartilhado', userId: a.id, externalId: jidGrupo } });
  const grupoB = await prisma.group.create({ data: { name: 'Compartilhado', userId: b.id, externalId: jidGrupo, adminOnly: false, isAdmin: true, participants: 11 } });
  const antesB = await prisma.group.findUniqueOrThrow({ where: { id: grupoB.id } });
  const { WhatsAppProvider } = await import('./whatsapp.js');
  const base = mkdtempSync(join(tmpdir(), 'wa-selo-'));
  try {
    const provider = new WhatsAppProvider({ ownerId: a.id, sessionDir: join(base, 'a') });
    Object.assign(provider, {
      data: { state: 'connected', accountJid: JID_A },
      socket: {
        user: { id: JID_A },
        groupMetadata: async () => ({ announce: true, size: 42, participants: [{ id: JID_A, admin: 'admin' }] }),
        sendMessage: async () => ({ key: { id: '3EB0SELO' } }),
      },
    });
    await provider.send(jidGrupo, 'oi', JID_A, null, grupoA.id);
    const depoisA = await prisma.group.findUniqueOrThrow({ where: { id: grupoA.id } });
    assert.deepEqual([depoisA.adminOnly, depoisA.isAdmin, depoisA.participants], [true, true, 42], 'o grupo de A recebeu o selo');
    const depoisB = await prisma.group.findUniqueOrThrow({ where: { id: grupoB.id } });
    assert.deepEqual(depoisB, antesB, 'o grupo de B ficou idêntico');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ─── Endurecimento de segurança (ADR-023) ───────────────────────────────────────
test('sessions: an absolute 30-day limit applies even to a session used every day', async () => {
  const email = 'sessao-antiga@teste.local';
  await prisma.user.upsert({ where: { email }, update: { disabledAt: null }, create: { email, name: 'Antiga', passwordHash: await hashPassword('senha-de-teste-123') } });
  const login = await loginAs(app, email);
  const headers = { host: 'localhost', origin: PANEL, cookie: login.cookie };
  const session = await prisma.authSession.findFirstOrThrow({ where: { user: { email } }, orderBy: { createdAt: 'desc' } });
  // Quase no limite: a renovação deslizante nunca passa do prazo absoluto.
  const nearLimit = new Date(Date.now() - SESSION_MAX_AGE_MS + 3_600_000);
  await prisma.authSession.update({ where: { id: session.id }, data: { createdAt: nearLimit, expiresAt: new Date(Date.now() + 60_000) } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode, 200);
  const renewed = await prisma.authSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.ok(renewed.expiresAt.getTime() <= nearLimit.getTime() + SESSION_MAX_AGE_MS, 'renovação limitada ao prazo absoluto');
  // Além do prazo: sessão recusada e apagada, mesmo com expiresAt no futuro.
  await prisma.authSession.update({ where: { id: session.id }, data: { createdAt: new Date(Date.now() - SESSION_MAX_AGE_MS - 1000), expiresAt: new Date(Date.now() + 86_400_000) } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode, 401);
  assert.equal(await prisma.authSession.count({ where: { id: session.id } }), 0, 'a sessão vencida sai do banco');
});

test('headers: responses carry the isolation headers', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost' } });
  assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
});

// ─── Migração da sessão legada (ADR-024, Fase 4E) e ponta a ponta (4F) ──────────
// Sessões FALSAS em pastas temporárias. A sessão real do dono nunca entra aqui.
function fakeLegacySession(files = 40) {
  const base = mkdtempSync(join(tmpdir(), 'wa-migra-'));
  const legacy = join(base, 'whatsapp');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'creds.json'), JSON.stringify({ me: { id: '5511MIGRA:7@s.whatsapp.net', lid: '99@lid' }, noiseKey: { private: 'x' } }));
  for (let i = 0; i < files; i++) writeFileSync(join(legacy, `session-${i}.json`), JSON.stringify({ chave: i, dado: 'y'.repeat(50) }));
  const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]));
  return { base, legacy, snapshot, before: snapshot(legacy), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
async function migrationOwner() {
  const owner = await prisma.user.upsert({ where: { email: 'migra-dono@teste.local' }, update: { role: 'SUPER_ADMIN', disabledAt: null }, create: { email: 'migra-dono@teste.local', name: 'Dono', role: 'SUPER_ADMIN', passwordHash: await hashPassword('senha-de-teste-123') } });
  const restore = await onlySuperAdmin(owner.id);
  return { owner, restore };
}
const quiet = { log: () => undefined };

test('migration (4E): the global session becomes the owner session, byte for byte, without QR', async () => {
  const session = fakeLegacySession();
  const { owner, restore } = await migrationOwner();
  try {
    const result = await migrateLegacySession({ sessionsBase: session.base, ...quiet });
    assert.equal(result.outcome, 'migrada');
    const target = whatsappSessionDir(owner.id, session.base);
    assert.ok(!existsSync(session.legacy), 'a pasta global deixou de existir (foi movida, não copiada)');
    assert.deepEqual(session.snapshot(target), session.before, 'todos os arquivos idênticos na pasta do dono');
    assert.ok(existsSync(migrationRecordPath(owner.id, session.base)), 'registro da migração ao lado da pasta');
    const row = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: owner.id } });
    assert.equal(row.autoConnect, true, 'reconecta sozinha na partida');
    // Idempotente: a próxima partida não faz nada.
    assert.equal((await migrateLegacySession({ sessionsBase: session.base, ...quiet })).outcome, 'sem-sessao-legada');
    assert.deepEqual(session.snapshot(target), session.before);
    // A ponte legada se desliga sozinha.
    assert.equal(await legacySessionOwnerId({ legacyProvider: { hasPairedSession: async () => existsSync(join(session.legacy, 'creds.json')) }, ownSessionDir: id => whatsappSessionDir(id, session.base) }), null);
    // Reverter devolve tudo, idêntico.
    assert.equal((await rollbackLegacySession(owner.id, { sessionsBase: session.base })).outcome, 'revertida');
    assert.deepEqual(session.snapshot(session.legacy), session.before);
    assert.ok(!existsSync(target));
    assert.equal((await rollbackLegacySession(owner.id, { sessionsBase: session.base })).outcome, 'nada-a-reverter');
  } finally { await prisma.whatsAppSession.deleteMany({ where: { userId: owner.id } }); await restore(); session.cleanup(); }
});

test('migration (4E): with an ambiguous owner, a conflict or an OS failure nothing moves', async () => {
  // Dono ambíguo: dois SUPER_ADMIN ativos.
  let session = fakeLegacySession(5);
  const outro = await prisma.user.upsert({ where: { email: 'migra-outro@teste.local' }, update: { role: 'SUPER_ADMIN', disabledAt: null }, create: { email: 'migra-outro@teste.local', name: 'Outro', role: 'SUPER_ADMIN', passwordHash: 'x' } });
  try {
    assert.equal((await migrateLegacySession({ sessionsBase: session.base, ...quiet })).outcome, 'dono-ambiguo');
    assert.deepEqual(session.snapshot(session.legacy), session.before, 'nada mudou');
    assert.ok(!existsSync(join(session.base, 'users')), 'nenhuma pasta nova');
  } finally { await prisma.user.update({ where: { id: outro.id }, data: { role: 'USER' } }); session.cleanup(); }

  const { owner, restore } = await migrationOwner();
  try {
    // Conflito: a pasta do dono já existe (ex.: pareou de novo pelo painel).
    session = fakeLegacySession(5);
    mkdirSync(whatsappSessionDir(owner.id, session.base), { recursive: true });
    writeFileSync(join(whatsappSessionDir(owner.id, session.base), 'creds.json'), '{"me":{"id":"novo"}}');
    const conflict = await migrateLegacySession({ sessionsBase: session.base, ...quiet });
    assert.equal(conflict.outcome, 'conflito');
    assert.deepEqual(session.snapshot(session.legacy), session.before, 'a legada ficou intacta');
    assert.equal(readFileSync(join(whatsappSessionDir(owner.id, session.base), 'creds.json'), 'utf8'), '{"me":{"id":"novo"}}', 'a nova também');
    session.cleanup();

    // Falha do sistema operacional (arquivo em uso): nada se perde e a ponte segue valendo.
    session = fakeLegacySession(5);
    const failed = await migrateLegacySession({ sessionsBase: session.base, renameDir: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, ...quiet });
    assert.deepEqual([failed.outcome, 'detail' in failed ? failed.detail : ''], ['falhou', 'EBUSY']);
    assert.deepEqual(session.snapshot(session.legacy), session.before);
    assert.ok(!existsSync(whatsappSessionDir(owner.id, session.base)), 'não sobra pasta vazia que desligaria a ponte');
    assert.equal(await legacySessionOwnerId({ legacyProvider: { hasPairedSession: async () => true }, ownSessionDir: id => whatsappSessionDir(id, session.base) }), owner.id, 'a ponte continua levando ao dono');

    // Desligada por variável de ambiente.
    assert.equal((await migrateLegacySession({ sessionsBase: session.base, env: { WHATSAPP_MIGRATE_LEGACY: '0' }, ...quiet })).outcome, 'desligada');
    assert.deepEqual(session.snapshot(session.legacy), session.before);
  } finally { await restore(); session.cleanup(); }
});

test('end to end (4F): after migration the owner reconnects by himself and sends through his own connection', async () => {
  const session = fakeLegacySession(10);
  const { owner, restore } = await migrationOwner();
  const { a } = await owners();
  await pauseEverything();
  try {
    assert.equal((await migrateLegacySession({ sessionsBase: session.base, ...quiet })).outcome, 'migrada');
    // Conexões: o provider do dono lê a sessão migrada de verdade para saber se está pareada.
    const sent: { owner: string; jid: string }[] = [];
    const manager = new WhatsAppManager({
      sessionsBase: session.base,
      createProvider: (ownerId, sessionDir) => {
        let state = 'disconnected';
        return {
          ownerId, sessionDir,
          status: () => ({ state, ...(state === 'connected' ? { accountJid: JID_LEGADO } : {}) }),
          hasPairedSession: async () => existsSync(join(sessionDir, 'creds.json')),
          connect: async () => { state = 'connected'; return { state }; },
          disconnect: async () => ({ state: 'disconnected' }), stop: async () => undefined, sync: async () => ({ count: 0 }),
          flushReads: async () => undefined, flushDeliveryEvents: async () => undefined,
          send: async (jid: string) => { sent.push({ owner: ownerId, jid }); return { messageId: `3EB0E2E${sent.length}`, context: '' }; },
        };
      },
    });
    const started = await manager.startAll({} as NodeJS.ProcessEnv);
    assert.equal(started.find(r => r.userId === owner.id)?.outcome, 'conectando', 'o dono reconectou sem QR');
    // Sessão global vazia depois da migração: provider legado sem sessão pareada.
    const legacyCalls: string[] = [];
    const legacy = { ...manager.for(owner.id), status: () => ({ state: 'connected', accountJid: 'nao-usar' }), hasPairedSession: async () => false, send: async () => { legacyCalls.push('send'); return { messageId: 'x', context: '' }; } };
    await manager.stop(owner.id); await manager.startAll({} as NodeJS.ProcessEnv); // "reinício"
    const router = createSendingRouter<ManagedProvider>({ manager, legacyProvider: legacy as ManagedProvider });
    const mine = await ownedCampaign(owner.id, JID_LEGADO);
    const theirs = await ownedCampaign(a.id, JID_A);
    const dispatcher = await startDispatcher(router, { scanIntervalMs: 50 });
    try {
      await waitFor(async () => (await fresh(mine.rows[0].id)).status === 'SENT', 'campanha do dono enviada');
      await sleep(300);
      assert.deepEqual(sent.map(s => s.owner), [owner.id], 'só pela conexão do dono');
      assert.equal((await fresh(theirs.rows[0].id)).status, 'PENDING', 'o USER sem conexão não pega carona');
      assert.deepEqual(legacyCalls, [], 'a sessão global não é mais usada');
    } finally { await dispatcher.stop(); await manager.stopAll(); }
  } finally { await prisma.whatsAppSession.deleteMany({ where: { userId: owner.id } }); await restore(); session.cleanup(); }
});

// ─── Envios em paralelo entre números (ADR-025, Fase 5) ─────────────────────────
test('parallel (5): different numbers send at the same time; a slow number does not hold the others', async () => {
  const { a, b } = await owners();
  await pauseEverything();
  // O relógio de cada número é persistido: sem zerar, o intervalo do teste anterior interfere.
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [JID_A, JID_B] } } });
  const world = sendingWorld();
  try {
    const slow = world.connect(a.id, JID_A);
    world.connect(b.id, JID_B);
    const original = slow.provider.send;
    // O número de A está lento: cada envio leva 2,5 s.
    slow.provider.send = async (...args: Parameters<typeof original>) => { await sleep(2500); return original(...args); };
    const campaignA = await ownedCampaign(a.id, JID_A, 1);
    const campaignB = await ownedCampaign(b.id, JID_B, 2, 1);
    const dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      // B termina os DOIS envios enquanto o primeiro de A ainda está em andamento.
      await waitFor(async () => (await prisma.delivery.findMany({ where: { campaignId: campaignB.campaign.id } })).every(d => d.status === 'SENT'), 'B terminou', 15_000);
      assert.equal((await fresh(campaignA.rows[0].id)).status, 'PROCESSING', 'A ainda está enviando: B não esperou por ele');
      await waitFor(async () => (await fresh(campaignA.rows[0].id)).status === 'SENT', 'A terminou', 15_000);
      const [aRow] = await prisma.delivery.findMany({ where: { campaignId: campaignA.campaign.id } });
      const [bFirst] = await prisma.delivery.findMany({ where: { campaignId: campaignB.campaign.id }, orderBy: { sequence: 'asc' } });
      assert.ok(bFirst.attemptedAt! < aRow.sendReturnedAt!, 'os dois números enviaram ao mesmo tempo');
      // Cada número por si: nenhum grupo trocado de número.
      assert.deepEqual(slow.sent.map(s => s.jid), campaignA.groups.map(g => g.externalId));
      assert.deepEqual(world.fakes.get(b.id)!.sent.map(s => s.jid), campaignB.groups.map(g => g.externalId));
    } finally { await dispatcher.stop(); }
    world.legacyIntact();
  } finally { world.cleanup(); }
});

test('parallel (5): stopping waits for the sends in progress on every number', async () => {
  const { a, b } = await owners();
  await pauseEverything();
  // O relógio de cada número é persistido: sem zerar, o intervalo do teste anterior interfere.
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [JID_A, JID_B] } } });
  const world = sendingWorld();
  try {
    for (const [user, jid] of [[a, JID_A], [b, JID_B]] as const) {
      const fake = world.connect(user.id, jid);
      const original = fake.provider.send;
      fake.provider.send = async (...args: Parameters<typeof original>) => { await sleep(800); return original(...args); };
    }
    const campaignA = await ownedCampaign(a.id, JID_A);
    const campaignB = await ownedCampaign(b.id, JID_B);
    const dispatcher = await startDispatcher(world.router, { scanIntervalMs: 50 });
    try {
      await waitFor(async () => (await prisma.delivery.count({ where: { id: { in: [campaignA.rows[0].id, campaignB.rows[0].id] }, status: 'PROCESSING' } })) === 2, 'os dois números enviando');
    } finally { await dispatcher.stop(); }
    // Nada fica pendurado em "enviando": os dois terminaram antes do stop voltar.
    assert.equal((await fresh(campaignA.rows[0].id)).status, 'SENT');
    assert.equal((await fresh(campaignB.rows[0].id)).status, 'SENT');
    world.legacyIntact();
  } finally { world.cleanup(); }
});

// Por último: apaga os usuários deste banco de teste para simular a primeira subida.
test('bootstrapAdmin: the first automatic account is SUPER_ADMIN, and it never runs twice', async () => {
  // Contas com dados não podem ser apagadas (ADR-017): limpa os dados do banco de teste antes.
  await prisma.campaign.deleteMany(); // envios, leituras, vínculos, mensagens e horários vão junto
  await prisma.whatsAppSession.deleteMany();
  await prisma.campaignMedia.deleteMany();
  await prisma.group.deleteMany();
  await prisma.user.deleteMany();
  const logs: string[] = [];
  assert.equal(await bootstrapAdmin({ ADMIN_EMAIL: 'Primeiro@Teste.local', ADMIN_PASSWORD: 'senha-de-teste-123' }, m => logs.push(m)), 'created');
  const first = await prisma.user.findUniqueOrThrow({ where: { email: 'primeiro@teste.local' } });
  assert.equal(first.role, 'SUPER_ADMIN');
  assert.equal(await bootstrapAdmin({ ADMIN_EMAIL: 'outro@teste.local', ADMIN_PASSWORD: 'senha-de-teste-123' }, m => logs.push(m)), 'exists');
  assert.equal(await prisma.user.count(), 1);
});
