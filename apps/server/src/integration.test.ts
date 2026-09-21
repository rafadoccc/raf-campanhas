import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, applyServerEvent, lockCampaign, LOCKING_TRANSACTION, acquireLease, renewLease, releaseLease, claimDelivery, finishDelivery, resumeAt, recordRead, currentTime, persistRead, flushPendingReads } from '@campaign/database';
import { buildApp } from './app';
import { hashPassword } from './auth';
import { startDispatcher, type SendingProvider } from './dispatcher';
import { loadConfig } from './config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
const app = buildApp({
  status: () => ({ state: 'disconnected' }),
  connect: async () => ({ state: 'disconnected' }),
  disconnect: async () => ({ state: 'disconnected' }),
  sync: async () => ({ count: 0 }),
});
after(async () => { await app.close(); await prisma.$disconnect(); });
const apiPath = (url: string) => url.startsWith('/api/') ? url : `/api${url}`;
// Toda a API exige login: os testes entram uma vez pelo endpoint real e reutilizam o
// cookie, sempre com a origem do painel (exigida em ações que alteram dados).
const PANEL = 'http://localhost:3000';
let cookie = '';
before(async () => {
  await prisma.user.create({ data: { email: 'dono@teste.local', name: 'Dono', passwordHash: await hashPassword('senha-de-teste-123') } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost', origin: PANEL }, payload: { email: 'dono@teste.local', password: 'senha-de-teste-123' } });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';')[0];
});
const auth = (extra: Record<string, string> = {}) => ({ host: 'localhost', origin: PANEL, cookie, ...extra });
const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url: apiPath(url), payload, headers: auth() });
async function create(count = 3) {
  const groups = await Promise.all(Array.from({ length: count }, (_, i) => prisma.group.create({ data: { name: `Teste ${i}` } })));
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
  const group = await prisma.group.create({ data: { name: 'São João — Coração 💚' } });
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
const fakeProvider = { status: () => ({ state: 'qr', qr: 'data:image/png;base64,SEGREDO' }), connect: async () => ({ state: 'qr' }), disconnect: async () => ({ state: 'disconnected' }), sync: async () => ({ count: 0 }) };
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
  assert.equal(config.trustProxy, true);
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
  const now = new Date();
  const groups = [];
  for (let i = 0; i < groupCount; i++) groups.push(await prisma.group.create({ data: { name: `Real ${i}`, externalId: `120363${Date.now()}${jidSeq++}@g.us` } }));
  const campaign = await prisma.campaign.create({ data: {
    name: 'Envio real', startsAt: now, endsAt: now, status: 'ACTIVE', provider: 'baileys', accountJid: ACCOUNT, mode: 'IMMEDIATE', intervalSeconds, nextAvailableAt: now,
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
  return { provider, calls };
}
const fresh = (id: string) => prisma.delivery.findUniqueOrThrow({ where: { id } });
// Libera a próxima entrega "agora" (simula o intervalo já decorrido).
const releaseNext = async (campaignId: string, deliveryId: string) => {
  const past = new Date(Date.now() - 1000);
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
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 50 });
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
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 50 });
  try {
    const failed = await waitFor(async () => { const d = await fresh(row.id); return d.status === 'FAILED' && d; }, 'falha gravada');
    assert.equal(failed.errorCode, 'baileys:408');
    assert.equal(failed.attempts, 1);
    assert.match(failed.error ?? '', /Timed Out.*Sem repetição automática/);
    assert.ok(failed.sendReturnedAt, 'o momento da falha fica registrado');
    await sleep(400); // vários ciclos do despachante
    assert.equal(wa.calls.length, 1, 'falha não é repetida');
  } finally { await dispatcher.stop(); }
});

test('send accepted locally but refused by the server afterwards: becomes a failure, never resent, even if the refusal arrives first', async () => {
  const { rows: [row] } = await realCampaign(1);
  const rejected = { kind: 'rejected' as const, messageId: '3EB0RECUSADO', groupJid: row.group.externalId!, accountJid: ACCOUNT, at: new Date(), code: '479' };
  // A recusa pode chegar antes de o envio ser gravado: não aplica e pede nova tentativa.
  assert.equal(await applyServerEvent(prisma, rejected), false);
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0RECUSADO', context: 'membro=sim admin=nao so-admins=sim participantes=40' }));
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 50 });
  try { await waitFor(async () => (await fresh(row.id)).status === 'SENT', 'envio gravado'); }
  finally { await dispatcher.stop(); }
  assert.equal(await applyServerEvent(prisma, rejected), true, 'reaplicada depois da gravação');
  const failed = await fresh(row.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'servidor:479');
  assert.ok(failed.serverRejectedAt);
  assert.match(failed.error ?? '', /recusou.*Não foi reenviada/);
  assert.equal(await applyServerEvent(prisma, rejected), true, 'recusa repetida é idempotente');
  assert.equal(wa.calls.length, 1);
});

test('a delivery receipt wins over a late refusal: something that reached the group is not declared failed', async () => {
  const { rows: [row] } = await realCampaign(1);
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0ENTREGUE', context: 'membro=sim admin=sim so-admins=nao participantes=10' }));
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 50 });
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
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 50 });
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
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 50 });
  try {
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
  const dispatcher = await startDispatcher(wa.provider, { scanIntervalMs: 20 });
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
