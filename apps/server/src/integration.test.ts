import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, localMinute, rulesFor, releaseStuckSends, SEND_TIMEOUT_CODE, applyServerEvent, lockCampaign, LOCKING_TRANSACTION, acquireLease, renewLease, releaseLease, claimDelivery, finishDelivery, resumeAt, recordRead, currentTime, persistRead, flushPendingReads } from '@campaign/database';
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
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { videoFixture } from './media-fixture';
import { validateMedia, IMAGE_LIMIT, VIDEO_LIMIT, backfillMediaPreviews } from './media';
import { deleteAccount, purgeExpiredData } from './legal';
import { checkRejections, recoverConfirmedRejections, safetyPause, SAFETY_REASONS, REJECTIONS_TO_PAUSE } from './safety';
import Fastify from 'fastify';
import { registerAuth } from './auth';
import { registerPasswordReset } from './password-reset';
import { collectAlerts, deliverAlerts, registerAlertRoutes, parsePhone, ALERT_EXPIRY_MS } from './owner-alerts';
import { pauseBlockedAccounts, planOf, todayOf } from './plans';
import { registerCampaignRoutes } from './campaign-routes';

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
  const payload = { name: 'Editada', mode: 'IMMEDIATE', intervalSeconds: 240, messages: ['novo texto', 'segunda'], groupIds: groups.map(g => g.id).reverse() };
  const result = await request('PATCH', `/campaigns/${id}`, payload);
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().id, id);
  const detail = (await request('GET', `/campaigns/${id}`)).json();
  assert.equal(detail.name, 'Editada'); assert.equal(detail.intervalSeconds, 240);
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
  assert.ok(!(await request('GET', '/campaigns')).json().items.some((c: {id: string}) => c.id === id));
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
  for (const intervalSeconds of [0, -1, 59, 60, 179, 3601, 90.5, '180']) assert.equal((await request('POST', '/campaigns', { name: 'Invalid', intervalSeconds })).statusCode, 400);
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

test('old unmatched receipts expire, but an old matching receipt is still counted first', async () => {
  const { id, groups } = await create(1); await activate(id);
  const [delivery] = await deliveries(id);
  const old = new Date('2020-01-01T12:00:00Z');
  const groupJid = `${groups[0].id}@g.us`;
  await prisma.campaign.update({ where: { id }, data: { accountJid: 'retencao-conta' } });
  await prisma.group.update({ where: { id: groups[0].id }, data: { externalId: groupJid } });
  await prisma.delivery.update({ where: { id: delivery.id }, data: { provider: 'baileys', providerId: `antiga-${id}`, status: 'SENT' } });
  await persistRead(prisma, { messageId: `antiga-${id}`, groupJid, accountJid: 'retencao-conta', participant: 'leitor', readAt: old });
  await persistRead(prisma, { messageId: `sem-entrega-${id}`, groupJid, accountJid: 'retencao-conta', participant: 'leitor', readAt: old });
  await flushPendingReads(prisma);
  assert.equal(await prisma.deliveryRead.count({ where: { deliveryId: delivery.id } }), 1, 'leitura antiga comprovada entra na métrica');
  assert.equal(await prisma.pendingRead.count({ where: { messageId: `sem-entrega-${id}` } }), 0, 'leitura antiga sem envio não cresce indefinidamente');
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
  assert.ok(dashboard.recentActivity.length <= 20, 'atividade recente: até 20 itens (rolagem própria na tela)');
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
  const r = await request('POST', '/campaigns', { name: 'Ç'.repeat(200), mode: 'IMMEDIATE', intervalSeconds: 180, messages: [longMessage], groupIds: [group.id] });
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

test('revocation between session lookup and refresh returns 401 without recreating the session', async () => {
  for (const renewal of [true, false]) {
    const { user, call } = await lgpdUser(`revoked-refresh-${renewal}@teste.local`);
    const session = await prisma.authSession.findFirstOrThrow({ where: { userId: user.id } });
    await prisma.authSession.update({
      where: { id: session.id },
      data: {
        expiresAt: new Date(Date.now() + (renewal ? 60_000 : 200 * 3_600_000)),
        lastSeenAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const original = prisma.authSession.findUnique;
    const lookup = original.bind(prisma.authSession);
    // O delegate Prisma é um Proxy sem descriptor de método: restaura a substituição
    // explicitamente, em vez de usar mock.method, que depende desse descriptor.
    prisma.authSession.findUnique = (async (...args: Parameters<typeof lookup>) => {
      const row = await lookup(...args);
      if (row?.id === session.id) await prisma.authSession.delete({ where: { id: row.id } });
      return row;
    }) as unknown as typeof original;
    try {
      const response = await call('GET', '/api/auth/me');
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.headers['set-cookie'], undefined, 'não renova cookie revogado');
      assert.equal(await prisma.authSession.count({ where: { id: session.id } }), 0);
    } finally { prisma.authSession.findUnique = original; }
  }
});

test('someone who knows the e-mail cannot lock the owner out from the device already logged in', async () => {
  await prisma.user.create({ data: { email: 'trava-login@teste.local', name: 'Dono', passwordHash: await hashPassword('senha-do-dono-123') } });
  const probe = buildApp(fakeProvider);
  const login = (password: string, remoteAddress: string) => probe.inject({ method: 'POST', url: '/api/auth/login', headers: anon, remoteAddress, payload: { email: 'trava-login@teste.local', password } });
  try {
    assert.equal((await login('senha-do-dono-123', '198.51.100.7')).statusCode, 200, 'o dono entra do celular');
    // Atacante erra de vários IPs até travar o e-mail.
    for (let i = 0; i < 10; i++) await login('chute-' + i, `203.0.113.${i + 1}`);
    assert.equal((await login('senha-do-dono-123', '203.0.113.99')).statusCode, 429, 'IP desconhecido segue bloqueado, mesmo com a senha certa');
    assert.equal((await login('senha-do-dono-123', '198.51.100.7')).statusCode, 200, 'o aparelho do dono continua entrando');
    // Do aparelho conhecido, o limite por IP ainda segura força bruta.
    for (let i = 0; i < 10; i++) await login('chute-local-' + i, '198.51.100.7');
    assert.equal((await login('senha-do-dono-123', '198.51.100.7')).statusCode, 429);
  } finally { await probe.close(); }
});

test('health reports an inactive dispatcher instead of advertising a healthy system', async () => {
  const probe = buildApp(fakeProvider, undefined, undefined, () => false);
  try {
    const health = await probe.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost' } });
    assert.equal(health.statusCode, 503);
    assert.equal(health.json().dispatcher, 'inactive');
  } finally { await probe.close(); }
});

test('lease loss stops the dispatcher and calls its failure handler once', async () => {
  const wa = fakeWhatsApp(okSend);
  let failures = 0;
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 1000, leaseRenewMs: 50, onLeaseLost: () => { failures++; } });
  try {
    await prisma.workerLease.update({ where: { id: 'worker' }, data: { ownerId: 'outro-processo' } });
    await waitFor(async () => !dispatcher.isActive() && failures === 1, 'fila para após perder posse', 3000);
    assert.equal(failures, 1);
  } finally {
    await dispatcher.stop();
    await prisma.workerLease.deleteMany({ where: { id: 'worker', ownerId: 'outro-processo' } });
  }
});

test('password change revokes other sessions together with the new hash', async () => {
  const probe = buildApp(fakeProvider);
  const email = 'troca-atomica@teste.local';
  const user = await prisma.user.create({ data: { email, name: 'Troca', passwordHash: await hashPassword('senha-antiga-forte') } });
  try {
    const first = await loginAs(probe, email, 'senha-antiga-forte');
    const other = await loginAs(probe, email, 'senha-antiga-forte');
    const changed = await probe.inject({ method: 'POST', url: '/api/auth/password', headers: as(first.cookie), payload: { current: 'senha-antiga-forte', next: 'senha-nova-forte' } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: as(first.cookie) })).statusCode, 200, 'sessão atual continua');
    assert.equal((await probe.inject({ method: 'GET', url: '/api/auth/me', headers: as(other.cookie) })).statusCode, 401, 'outra sessão foi revogada');
    assert.equal((await loginAs(probe, email, 'senha-antiga-forte')).status, 401);
    assert.equal((await loginAs(probe, email, 'senha-nova-forte')).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash === user.passwordHash, false);
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
  writeFileSync(join(dist, 'index.html'), '<!doctype html><meta property="og:image" content="__PUBLIC_URL__/og.png"><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const probe = buildApp(fakeProvider, loadConfig({ WEB_DIST: dist }));
  try {
    for (const url of ['/', '/campanhas', '/campanhas/abc/editar', '/login']) {
      const page = await probe.inject({ method: 'GET', url, headers: { host: 'localhost' } });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.body, /id="root"/, url);
      // A imagem de compartilhamento sai com o endereço público completo, em qualquer tela.
      assert.match(page.body, /content="https?:\/\/[^"/]+\/og\.png"/, url);
    }
    const asset = await probe.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: { host: 'localhost' } });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['cache-control']), /immutable/);
    const missing = await probe.inject({ method: 'GET', url: '/api/nao-existe', headers: auth() });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, 'Rota não encontrada.');
    // Recompilar com o sistema ligado (bug de 2026-09-24): o arquivo novo é servido na hora…
    writeFileSync(join(dist, 'assets', 'app-novo456.js'), 'console.log(2)');
    const fresh = await probe.inject({ method: 'GET', url: '/assets/app-novo456.js', headers: { host: 'localhost' } });
    assert.equal(fresh.statusCode, 200, 'arquivo criado depois da partida');
    assert.match(String(fresh.headers['content-type']), /javascript/);
    // …e um arquivo que não existe é 404 de verdade, nunca o index.html fingindo ser o .js.
    const gone = await probe.inject({ method: 'GET', url: '/assets/app-sumiu.js', headers: { host: 'localhost' } });
    assert.equal(gone.statusCode, 404);
    assert.doesNotMatch(gone.body, /id="root"/);
    writeFileSync(join(dist, '.env'), 'SEGREDO=1');
    assert.notEqual((await probe.inject({ method: 'GET', url: '/.env', headers: { host: 'localhost' } })).body, 'SEGREDO=1', 'arquivo oculto nunca é servido');
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

test('stuck send (044): no answer from WhatsApp never blocks the queue; the connection is renewed and a late answer marks it sent', async () => {
  const { campaign, rows: [first, second] } = await realCampaign(2);
  let answerFirst: (result: SendResult) => void = () => undefined;
  // 1º envio: o WhatsApp nunca responde (como o upload pendurado de 30/09). 2º: normal.
  const wa = fakeWhatsApp(async (_jid, call) => call === 1 ? new Promise<SendResult>(resolve => { answerFirst = resolve; }) : { messageId: '3EB0SEGUNDO', context: '' });
  let recycled = 0;
  (wa.provider as unknown as { recycle: () => void }).recycle = () => { recycled++; };
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50, sendTimeoutMs: 300 });
  try {
    const failed = await waitFor(async () => { const d = await fresh(first.id); return d.status === 'FAILED' && d; }, 'envio sem resposta encerrado');
    assert.equal(failed.errorCode, SEND_TIMEOUT_CODE);
    assert.match(failed.error ?? '', /incerto/, 'sem reenvio automático: pode ter saído');
    assert.equal(recycled, 1, 'a conexão emperrada é renovada');
    await releaseNext(campaign.id, second.id);
    await waitFor(async () => (await fresh(second.id)).status === 'SENT', 'a fila andou');
    // A resposta do 1º chega atrasada: ele saiu de verdade.
    answerFirst({ messageId: '3EB0ATRASADO', context: '' });
    const late = await waitFor(async () => { const d = await fresh(first.id); return d.status === 'SENT' && d; }, 'resposta atrasada vira enviado');
    assert.equal(late.providerId, '3EB0ATRASADO');
    assert.equal(late.errorCode, null);
  } finally { await dispatcher.stop(); }
});

test('stuck send (044): the cleanup releases an orphan "sending" row, never one this process is sending', async () => {
  const { rows: [orphan, running] } = await realCampaign(2);
  const longAgo = new Date(Date.now() - 60 * 60_000);
  for (const row of [orphan, running]) await prisma.delivery.update({ where: { id: row.id }, data: { status: 'PROCESSING', attemptedAt: longAgo } });
  assert.ok(await releaseStuckSends(prisma, 7 * 60_000, new Set([running.id])) >= 1);
  const released = await fresh(orphan.id);
  assert.equal(released.status, 'FAILED');
  assert.equal(released.errorCode, SEND_TIMEOUT_CODE);
  assert.equal((await fresh(running.id)).status, 'PROCESSING', 'o que está saindo agora não é mexido');
  await prisma.delivery.update({ where: { id: running.id }, data: { status: 'FAILED' } });
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
  assert.deepEqual(ids((await a.call('GET', '/campaigns')).json().items), [A.campaignId], '1. A lista só as campanhas de A');
  assert.deepEqual(ids((await b.call('GET', '/campaigns')).json().items), [B.campaignId], '2. B lista só as campanhas de B');
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
  assert.deepEqual(ids((await admin.call('GET', '/campaigns')).json().items), [own.campaignId], '14. só as campanhas dele');
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
  assert.deepEqual(ids((await asA('GET', `/campaigns?userId=${b.user.id}`)).json().items), [A.campaignId], '15. query/cabeçalho ignorados');
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
  // safetyPausedAt/safetyReason: aviso da pausa automática (ADR-041); warmup*: aquecimento
  // (ADR-043). Nenhuma é credencial.
  assert.deepEqual(columns, ['accountJid', 'autoConnect', 'createdAt', 'id', 'lastConnectedAt', 'lastError', 'safetyPausedAt', 'safetyReason', 'state', 'updatedAt', 'userId', 'warmupJid', 'warmupStartedAt'], 'nenhuma coluna de QR, creds ou chave do Baileys');
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

// Bug de 2026-09-24: o estado só era gravado no pedido de conectar; a produção ficou com
// "connecting" e sem número desde a partida, e a trava de número único nunca valia.
test('lifecycle: every state change is saved on its own, and a number already owned by another account is refused', async () => {
  const dono = await startupUser('estado-dono@teste.local');
  const intruso = await startupUser('estado-intruso@teste.local');
  const numero = `5511${Date.now().toString().slice(-8)}@s.whatsapp.net`;
  const hooks = new Map<string, { state: { state: string; accountJid?: string }; change(next: { state: string; accountJid?: string }): void; calls: string[] }>();
  const sessionsBase = mkdtempSync(join(tmpdir(), 'wa-estado-'));
  const manager = new WhatsAppManager({ sessionsBase, createProvider: (ownerId, sessionDir, onStateChange) => {
    const entry = { state: { state: 'disconnected' } as { state: string; accountJid?: string }, calls: [] as string[], change(next: { state: string; accountJid?: string }) { entry.state = next; onStateChange(); } };
    hooks.set(ownerId, entry);
    return { ownerId, sessionDir, status: () => ({ ...entry.state }), hasPairedSession: async () => true,
      connect: async () => ({ ...entry.state }), disconnect: async () => ({ state: 'disconnected' }),
      stop: async () => { entry.calls.push('stop'); entry.change({ state: 'disconnected' }); },
      sync: async () => ({ count: 0 }), send: async () => ({ messageId: 'x', context: '' }), flushReads: async () => undefined, flushDeliveryEvents: async () => undefined };
  } });
  const row = (id: string) => prisma.whatsAppSession.findUnique({ where: { userId: id } });
  try {
    manager.for(dono.id);
    hooks.get(dono.id)!.change({ state: 'connecting' });
    hooks.get(dono.id)!.change({ state: 'connected', accountJid: numero });
    await waitFor(async () => (await row(dono.id))?.state === 'connected', 'estado conectado gravado sozinho');
    assert.equal((await row(dono.id))!.accountJid, numero, 'o número pareado fica registrado');
    assert.ok((await row(dono.id))!.lastConnectedAt);
    // Outra conta pareia o MESMO número: é recusada e a conexão dela cai.
    manager.for(intruso.id);
    hooks.get(intruso.id)!.change({ state: 'connected', accountJid: numero });
    await waitFor(async () => (await row(intruso.id))?.state === 'error', 'conflito gravado');
    assert.match((await row(intruso.id))!.lastError ?? '', /outra conta/);
    assert.equal(manager.peek(intruso.id), undefined);
    assert.deepEqual(hooks.get(intruso.id)!.calls, ['stop']);
    assert.equal((await row(dono.id))!.accountJid, numero, 'o dono continua com o número');
    // Queda: o estado muda, o número continua reservado para o dono.
    hooks.get(dono.id)!.change({ state: 'reconnecting' });
    await waitFor(async () => (await row(dono.id))?.state === 'reconnecting', 'queda gravada');
    assert.equal((await row(dono.id))!.accountJid, numero);
  } finally { rmSync(sessionsBase, { recursive: true, force: true }); }
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
    assert.deepEqual(Object.keys(row).sort(), ['accountJid', 'autoConnect', 'createdAt', 'id', 'lastConnectedAt', 'lastError', 'safetyPausedAt', 'safetyReason', 'state', 'updatedAt', 'userId', 'warmupJid', 'warmupStartedAt'], 'nenhum campo de QR ou credencial');
    assert.equal(row.state, 'connected');
    // Número já pareado em outra conta: registra o motivo, sem quebrar a partida.
    await prisma.whatsAppSession.update({ where: { userId: user.id }, data: { accountJid: null } });
    await prisma.whatsAppSession.update({ where: { userId: outro.id }, data: { accountJid: row.accountJid } });
    await manager.persistState(user.id);
    const conflito = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(conflito.accountJid, null, 'não rouba o número do outro');
    assert.match(conflito.lastError ?? '', /já está conectado em outra conta/);
    // Um número, uma conta (ADR-019): a conexão duplicada é encerrada (sem logout).
    assert.equal(conflito.state, 'error');
    assert.equal(manager.peek(user.id), undefined, 'a duplicada sai do mapa');
    assert.deepEqual(calls.get(user.id), ['connect', 'stop'], 'stop, nunca disconnect');
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
    // Limite suave (035): de novo logo em seguida, recusa com aviso e não chama o provider.
    const again = await b.call('POST', 'sync');
    assert.equal(again.statusCode, 429);
    assert.match(again.json().error, /Aguarde \d+ s/);
    assert.equal((await b.call('GET', 'status')).json().groupsSync.count, 3, 'a tela vê a última sincronização');
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
        // A última sincronização (dele, feita acima) pode vir junto; a conexão continua a dele.
        const { groupsSync: _sync, ...own } = (await user.call('GET', 'status')).json();
        assert.deepEqual(own, { state: 'disconnected' }, 'declarar um USER não lhe dá a sessão global');
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
      // attempts sobe já na reserva (PROCESSING, sem erro); o erro só é gravado ao terminar.
      const row = await waitFor(async () => { const d = await fresh(campaign.rows[0].id); return d.attempts > 0 && d.status !== 'PROCESSING' && d; }, 'tentativa registrada');
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

// ─── Mídia com prévia, lista paginada, reuso e métricas (ADR-026) ───────────────
test('media (026): images get a dominant color and a small thumbnail; only the owner reads them', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#cc3300' } }).png().toBuffer();
  const up = await app.inject({ method: 'POST', url: '/api/media?name=laranja.png', headers: auth({ 'content-type': 'image/png' }), payload: png });
  assert.equal(up.statusCode, 201, up.body);
  assert.match(up.json().color, /^#[0-9a-f]{6}$/);
  const [r, g] = [parseInt(up.json().color.slice(1, 3), 16), parseInt(up.json().color.slice(3, 5), 16)];
  assert.ok(r > 150 && g < 120, `cor predominante laranja/vermelha: ${up.json().color}`);
  const thumb = await app.inject({ method: 'GET', url: `/api/media/${up.json().id}/thumb`, headers: auth() });
  assert.equal(thumb.statusCode, 200);
  assert.equal(thumb.headers['content-type'], 'image/webp');
  assert.match(String(thumb.headers['cache-control']), /private/);
  assert.match(String(thumb.headers['cache-control']), /no-store/);
  const full = await app.inject({ method: 'GET', url: `/api/media/${up.json().id}`, headers: auth() });
  assert.equal(full.statusCode, 200);
  assert.match(String(full.headers['cache-control']), /no-store/);
  assert.ok(thumb.rawPayload.length > 0);
  const intruso = await isoUser('midia-intruso@teste.local');
  assert.equal((await intruso.call('GET', `/media/${up.json().id}/thumb`)).statusCode, 404, 'miniatura de outro dono: 404');
  // Imagem antiga, sem prévia: ganha na primeira leitura da miniatura e no preenchimento da partida.
  const antiga = await prisma.campaignMedia.create({ data: { userId: ownerId, name: 'antiga.png', mimeType: 'image/png', kind: 'image', size: png.length, data: png } });
  assert.equal((await app.inject({ method: 'GET', url: `/api/media/${antiga.id}/thumb`, headers: auth() })).statusCode, 200);
  assert.ok((await prisma.campaignMedia.findUniqueOrThrow({ where: { id: antiga.id } })).color);
  const outra = await prisma.campaignMedia.create({ data: { userId: ownerId, name: 'outra.png', mimeType: 'image/png', kind: 'image', size: png.length, data: png } });
  await backfillMediaPreviews();
  const preenchida = await prisma.campaignMedia.findUniqueOrThrow({ where: { id: outra.id } });
  assert.ok(preenchida.color && preenchida.thumbnail, 'preenchimento em segundo plano');
});

// ─── Conversão automática de vídeo (ADR-032) ────────────────────────────────────
// Vídeos gerados na hora pelo próprio ffmpeg: MOV (como o do iPhone), MP4 fora do padrão.
function makeVideo(name: string, args: string[]) {
  const ffmpeg = (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  const dir = mkdtempSync(join(tmpdir(), 'video-teste-'));
  const file = join(dir, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-y', ...args, file]);
  assert.equal(run.status, 0, String(run.stderr).slice(-500));
  const data = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return data;
}
function probe(data: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'video-probe-'));
  const file = join(dir, 'v.mp4');
  writeFileSync(file, data);
  const out = spawnSync((require('ffprobe-static') as { path: string }).path, ['-v', 'error', '-show_streams', '-of', 'json', file]);
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(String(out.stdout)).streams as { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }[];
}
const upload = (name: string, type: string, payload: Buffer) => app.inject({ method: 'POST', url: `/api/media?name=${encodeURIComponent(name)}`, headers: auth({ 'content-type': type }), payload });

test('video (032): a MOV with sound is converted to MP4 H.264 + AAC, ready for WhatsApp', { timeout: 120_000 }, async () => {
  const mov = makeVideo('iphone.mov', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le']);
  const r = await upload('IMG_8114.MOV', 'video/quicktime', mov);
  assert.equal(r.statusCode, 201, r.body);
  const body = r.json();
  assert.equal(body.converted, true);
  assert.equal(body.mimeType, 'video/mp4');
  assert.equal(body.kind, 'video');
  assert.equal(body.name, 'IMG_8114.mp4');
  const saved = await prisma.campaignMedia.findUniqueOrThrow({ where: { id: body.id } });
  const streams = probe(Buffer.from(saved.data));
  assert.deepEqual(streams.map(s => `${s.codec_type}:${s.codec_name}`).sort(), ['audio:aac', 'video:h264']);
  assert.equal(streams.find(s => s.codec_type === 'video')!.pix_fmt, 'yuv420p');
  assert.equal(await validateMedia(Buffer.from(saved.data), 'video/mp4'), 'video', 'o resultado passa na mesma validação de sempre');
});

test('video (032): an iPhone "high efficiency" video (HEVC, 10-bit, portrait) becomes MP4 H.264', { timeout: 120_000 }, async () => {
  const hevc = makeVideo('iphone-hevc.mov', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=1080x1920:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac']);
  // Antes desta mudança, o mesmo tipo de arquivo como MP4 era recusado: HEVC não é H.264.
  await assert.rejects(validateMedia(makeVideo('hevc.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-c:v', 'libx265']), 'video/mp4'), /H\.264/);
  const r = await upload('IMG_0042.MOV', 'video/quicktime', hevc);
  assert.equal(r.statusCode, 201, r.body);
  const video = probe(Buffer.from((await prisma.campaignMedia.findUniqueOrThrow({ where: { id: r.json().id } })).data)).find(s => s.codec_type === 'video')!;
  assert.deepEqual([video.codec_name, video.pix_fmt, video.width, video.height], ['h264', 'yuv420p', 720, 1280], 'vertical: lado maior 1280, 8 bits');
});

test('video (032): an MP4 out of standard is converted and shrunk; a ready MP4 H.264 goes untouched', { timeout: 120_000 }, async () => {
  const wide = makeVideo('grande.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=2000x1000:rate=10', '-c:v', 'mpeg4']);
  const converted = await upload('grande.mp4', 'video/mp4', wide);
  assert.equal(converted.statusCode, 201, converted.body);
  assert.equal(converted.json().converted, true);
  const video = probe(Buffer.from((await prisma.campaignMedia.findUniqueOrThrow({ where: { id: converted.json().id } })).data)).find(s => s.codec_type === 'video')!;
  assert.deepEqual([video.codec_name, video.width, video.height], ['h264', 1280, 640], 'lado maior limitado a 1280 px, proporção mantida');
  // MP4 H.264 já no padrão: vai como veio, byte a byte (sem perder qualidade).
  const ready = await upload('pronto.mp4', 'video/mp4', videoFixture);
  assert.equal(ready.statusCode, 201, ready.body);
  assert.equal(ready.json().converted, false);
  assert.equal(ready.json().name, 'pronto.mp4');
  assert.ok(Buffer.from((await prisma.campaignMedia.findUniqueOrThrow({ where: { id: ready.json().id } })).data).equals(videoFixture));
  // Arquivo que não é vídeo de verdade: recusa com mensagem clara, nada é gravado.
  const broken = await upload('quebrado.mov', 'video/quicktime', Buffer.from('isto não é um vídeo'));
  assert.equal(broken.statusCode, 400);
  assert.match(broken.json().error, /não reconhecido/);
});

test('video (034): MKV and AVI are recognized by their signature and converted', { timeout: 120_000 }, async () => {
  for (const [name, type] of [['clipe.mkv', 'video/x-matroska'], ['clipe.avi', 'video/x-msvideo']]) {
    const data = makeVideo(name, ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-c:v', 'mpeg4']);
    const r = await upload(name, type, data);
    assert.equal(r.statusCode, 201, `${name}: ${r.body}`);
    assert.equal(r.json().converted, true);
  }
});

test('video (034): a playlist disguised as video never makes ffmpeg read server files or the network', { timeout: 60_000 }, async () => {
  // Ataque clássico: HLS/concat apontando para arquivos locais (o .env) ou para a rede.
  const secret = join(mkdtempSync(join(tmpdir(), 'segredo-')), 'segredo.txt');
  writeFileSync(secret, 'SENHA_DO_BANCO=nao-pode-vazar');
  const attacks = [
    `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile://${secret.replace(/\\/g, '/')}\n#EXT-X-ENDLIST\n`,
    `ffconcat version 1.0\nfile '${secret.replace(/\\/g, '/')}'\n`,
    '#EXTM3U\n#EXTINF:10.0,\nhttp://127.0.0.1:9/segredo\n#EXT-X-ENDLIST\n',
  ];
  for (const payload of attacks) {
    for (const type of ['video/quicktime', 'video/mp4', 'video/x-matroska']) {
      const r = await upload('ataque.mov', type, Buffer.from(payload));
      assert.equal(r.statusCode, 400, `${type}: ${r.body}`);
      assert.match(r.json().error, /não reconhecido|Use vídeo MP4|H\.264/);
    }
  }
  assert.equal(await prisma.campaignMedia.count({ where: { name: { startsWith: 'ataque' } } }), 0, 'nada foi gravado');
});

test('media (026): video ranges are read from the database in pieces, never the whole file', async () => {
  const data = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251;
  const video = await prisma.campaignMedia.create({ data: { userId: ownerId, name: 'grande.mp4', mimeType: 'video/mp4', kind: 'video', size: data.length, data } });
  const aberto = await app.inject({ method: 'GET', url: `/api/media/${video.id}`, headers: auth({ range: 'bytes=0-' }) });
  assert.equal(aberto.statusCode, 206);
  assert.equal(aberto.headers['content-range'], `bytes 0-${2 * 1024 * 1024 - 1}/${data.length}`, 'pedido aberto vem em pedaço de 2 MB');
  assert.ok(aberto.rawPayload.equals(data.subarray(0, 2 * 1024 * 1024)));
  const meio = await app.inject({ method: 'GET', url: `/api/media/${video.id}`, headers: auth({ range: 'bytes=3000000-3000099' }) });
  assert.equal(meio.headers['content-range'], `bytes 3000000-3000099/${data.length}`);
  assert.ok(meio.rawPayload.equals(data.subarray(3_000_000, 3_000_100)), 'trecho exato');
  const fim = await app.inject({ method: 'GET', url: `/api/media/${video.id}`, headers: auth({ range: 'bytes=-10' }) });
  assert.ok(fim.rawPayload.equals(data.subarray(data.length - 10)), 'sufixo');
  assert.equal((await app.inject({ method: 'GET', url: `/api/media/${video.id}`, headers: auth({ range: `bytes=${data.length}-` }) })).statusCode, 416);
});

test('campaign list (026): cursor pages with no duplicates, only card data', async () => {
  const dono = await isoUser('lista-paginada@teste.local');
  const group = await dono.call('POST', '/groups', { name: 'Grupo da lista' });
  for (let i = 0; i < 30; i++) {
    const r = await dono.call('POST', '/campaigns', draftBody([group.json().id], { name: `Lista ${String(i).padStart(2, '0')}` }));
    assert.equal(r.statusCode, 201, r.body);
  }
  const first = (await dono.call('GET', '/campaigns?limit=24')).json();
  assert.equal(first.items.length, 24);
  assert.ok(first.nextCursor);
  const second = (await dono.call('GET', `/campaigns?limit=24&cursor=${first.nextCursor}`)).json();
  assert.equal(second.items.length, 6);
  assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items].map((c: { id: string }) => c.id);
  assert.equal(new Set(all).size, 30, 'sem repetição entre páginas');
  const card = first.items[0];
  assert.equal(card.groupCount, 1);
  assert.equal(card.messages, undefined, 'o cartão não carrega as mensagens');
  assert.equal(card.name, 'Lista 29', 'mais recentes primeiro');
  // Filtros no servidor (funcionam junto com a paginação).
  assert.equal((await dono.call('GET', '/campaigns?q=Lista%2007')).json().items.length, 1);
  assert.equal((await dono.call('GET', '/campaigns?status=ACTIVE')).json().items.length, 0);
  assert.equal((await dono.call('GET', '/campaigns?status=DRAFT,ACTIVE&limit=50')).json().items.length, 30);
  assert.equal((await dono.call('GET', '/campaigns?status=QUALQUER')).json().items.length, 24, 'situação desconhecida é ignorada');
});

test('reuse (026): "use again" copies a campaign into a new draft; reschedule stops the old one atomically', async () => {
  const dono = await isoUser('reuso@teste.local');
  const g1 = (await dono.call('POST', '/groups', { name: 'Reuso 1' })).json();
  const g2 = (await dono.call('POST', '/groups', { name: 'Reuso 2' })).json();
  const media = (await dono.call('POST', '/media?name=reuso.png', await pngBytes(), { 'content-type': 'image/png' })).json();
  const original = (await dono.call('POST', '/campaigns', { ...draftBody([g1.id, g2.id], { mediaId: media.id }), name: 'Festa', messages: ['Olá', 'Oi de novo'] })).json();
  const copy = await dono.call('POST', `/campaigns/${original.id}/duplicate`, {});
  assert.equal(copy.statusCode, 201, copy.body);
  assert.equal(copy.json().name, 'Festa (2)');
  const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: copy.json().id }, include: { groups: { orderBy: { position: 'asc' } }, messages: { orderBy: { position: 'asc' } } } });
  assert.equal(saved.status, 'DRAFT');
  assert.deepEqual(saved.groups.map(g => g.groupId), [g1.id, g2.id], 'mesmos grupos, mesma ordem');
  assert.deepEqual(saved.messages.map(m => m.content), ['Olá', 'Oi de novo']);
  assert.equal(saved.mediaId, media.id);
  assert.equal((await dono.call('POST', `/campaigns/${copy.json().id}/duplicate`, {})).json().name, 'Festa (3)', 'numeração segue');
  // Outro usuário não copia: 404 igual a inexistente.
  const intruso = await isoUser('reuso-intruso@teste.local');
  assert.equal((await intruso.call('POST', `/campaigns/${original.id}/duplicate`, {})).statusCode, 404);
  // Reagendar só vale para ativa/pausada, e encerra a original na mesma transação.
  assert.equal((await dono.call('POST', `/campaigns/${original.id}/duplicate`, { reschedule: true })).statusCode, 400);
  const ativa = (await dono.call('POST', '/campaigns', { ...draftBody([g1.id, g2.id]), name: 'Em andamento' })).json();
  assert.equal((await dono.call('PATCH', `/campaigns/${ativa.id}/status`, { status: 'ACTIVE', provider: 'simulator' })).statusCode, 200);
  await prisma.delivery.updateMany({ where: { campaignId: ativa.id }, data: { scheduledAt: new Date(Date.now() + 86_400_000) } });
  const nova = await dono.call('POST', `/campaigns/${ativa.id}/duplicate`, { reschedule: true });
  assert.equal(nova.statusCode, 201, nova.body);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: ativa.id } })).status, 'CANCELLED');
  assert.equal(await prisma.delivery.count({ where: { campaignId: ativa.id, status: 'PENDING' } }), 0, 'nenhum envio pendente sobra na original');
  // Grupo que saiu (inativo) não entra na cópia; sem nenhum ativo, recusa.
  await prisma.group.update({ where: { id: g2.id }, data: { active: false } });
  const semG2 = (await dono.call('POST', `/campaigns/${original.id}/duplicate`, {})).json();
  assert.deepEqual((await prisma.campaignGroup.findMany({ where: { campaignId: semG2.id } })).map(g => g.groupId), [g1.id]);
  await prisma.group.update({ where: { id: g1.id }, data: { active: false } });
  assert.equal((await dono.call('POST', `/campaigns/${original.id}/duplicate`, {})).statusCode, 400);
});

test('dashboard (026): delivered today, delivery rate, reach and the last 7 days', async () => {
  const dono = await isoUser('metricas@teste.local');
  const now = new Date();
  const g1 = await prisma.group.create({ data: { name: 'M1', userId: dono.user.id, externalId: `120311${Date.now()}@g.us`, participants: 100 } });
  const g2 = await prisma.group.create({ data: { name: 'M2', userId: dono.user.id, externalId: `120312${Date.now()}@g.us`, participants: 50 } });
  await prisma.campaign.create({ data: {
    name: 'Métricas', userId: dono.user.id, startsAt: now, endsAt: now, status: 'COMPLETED', provider: 'baileys', accountJid: JID_A, mode: 'IMMEDIATE',
    groups: { create: [{ groupId: g1.id, position: 0 }, { groupId: g2.id, position: 1 }] },
    deliveries: { create: [
      { groupId: g1.id, messageBody: 'oi', provider: 'baileys', sequence: 0, status: 'SENT', sentAt: now, deliveredAt: now, scheduledAt: now },
      { groupId: g2.id, messageBody: 'oi', provider: 'baileys', sequence: 1, status: 'SENT', sentAt: now, scheduledAt: new Date(now.getTime() + 1) },
      { groupId: g1.id, messageBody: 'oi', provider: 'baileys', sequence: 2, status: 'SENT', sentAt: new Date(now.getTime() - 3 * 86_400_000), scheduledAt: new Date(now.getTime() + 2) },
    ] },
  } });
  const d = (await dono.call('GET', '/dashboard')).json();
  assert.equal(d.sentToday, 2);
  assert.equal(d.deliveredToday, 1);
  assert.equal(d.deliveryRate, 50);
  assert.equal(d.groupsReachedToday, 2);
  assert.equal(d.membersReachedToday, 150);
  assert.equal(d.last7Days.length, 7);
  assert.equal(d.last7Days[6].sent, 2, 'hoje');
  assert.equal(d.last7Days.reduce((s: number, x: { sent: number }) => s + x.sent, 0), 3, 'a semana inteira');
});

// ─── Painel do SUPER_ADMIN (ADR-027, Fase 6) ─────────────────────────────────────
test('admin (6): only SUPER_ADMIN reaches /api/admin, and it never exposes private content', async () => {
  const world = whatsappApp();
  try {
    const admin = await sessionFor(world.app, 'painel-admin@teste.local', 'SUPER_ADMIN');
    const user = await sessionFor(world.app, 'painel-user@teste.local');
    const asUser = await loginAs(world.app, 'painel-user@teste.local');
    const asAdmin = await loginAs(world.app, 'painel-admin@teste.local');
    const h = (cookie: string) => ({ host: 'localhost', origin: PANEL, cookie });
    for (const [method, url] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['PATCH', `/api/admin/users/${admin.user.id}`], ['POST', `/api/admin/users/${admin.user.id}/password`]] as const) {
      assert.equal((await world.app.inject({ method, url, payload: {}, headers: h(asUser.cookie) })).statusCode, 403, `USER em ${method} ${url}`);
      assert.equal((await world.app.inject({ method, url, payload: {}, headers: { host: 'localhost', origin: PANEL } })).statusCode, 401);
    }
    const list = await world.app.inject({ method: 'GET', url: '/api/admin/users', headers: h(asAdmin.cookie) });
    assert.equal(list.statusCode, 200);
    for (const segredo of ['passwordHash', 'scrypt', 'data:image', 'messageBody', '"content"']) assert.ok(!list.body.includes(segredo), `não expõe ${segredo}`);
    // O estado pode ser "qr" (aguardando leitura), mas o QR em si nunca vem.
    assert.ok(list.json().every((u: { whatsapp: object }) => !('qr' in u.whatsapp)), 'nenhum campo qr');
    const row = list.json().find((u: { id: string }) => u.id === user.user.id);
    assert.deepEqual(Object.keys(row.counts).sort(), ['activeCampaigns', 'campaigns', 'failed', 'groups', 'sent']);
    assert.ok('state' in row.whatsapp && 'accountJid' in row.whatsapp);
  } finally { await world.cleanup(); }
});

test('admin (6): create, disable, enable, reset password and change role — with the safety locks', async () => {
  const world = whatsappApp();
  try {
    const admin = await sessionFor(world.app, 'painel-admin2@teste.local', 'SUPER_ADMIN');
    const asAdmin = await loginAs(world.app, 'painel-admin2@teste.local');
    const h = { host: 'localhost', origin: PANEL, cookie: asAdmin.cookie };
    // Criar: papel padrão USER; e-mail repetido recusado; senha fraca recusada.
    const created = await world.app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { email: 'Novo.Usuario@Teste.local', name: 'Novo', password: 'senha-de-teste-123' } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().role, 'USER');
    assert.equal(created.json().email, 'novo.usuario@teste.local');
    assert.equal((await world.app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { email: 'novo.usuario@teste.local', name: 'X', password: 'senha-de-teste-123' } })).statusCode, 409);
    assert.equal((await world.app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { email: 'outro@teste.local', name: 'X', password: 'curta' } })).statusCode, 400);
    const novoId = created.json().id as string;
    // O novo usuário entra, tem uma campanha ativa e uma conexão aberta.
    const novo = await loginAs(world.app, 'novo.usuario@teste.local');
    assert.equal(novo.status, 200);
    world.manager.for(novoId);
    const group = await prisma.group.create({ data: { name: 'Do novo', userId: novoId } });
    const campaign = await prisma.campaign.create({ data: { name: 'Ativa do novo', userId: novoId, startsAt: new Date(), endsAt: new Date(), status: 'ACTIVE', groups: { create: [{ groupId: group.id, position: 0 }] } } });
    // Desativar: sessões caem, campanha pausa, conexão encerra SEM logout.
    const off = await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${novoId}`, headers: h, payload: { disabled: true } });
    assert.equal(off.statusCode, 200, off.body);
    assert.ok(off.json().disabledAt);
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'localhost', cookie: novo.cookie } })).statusCode, 401, 'sessão derrubada');
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'PAUSED');
    assert.deepEqual(world.perUser.get(novoId)!.calls, ['stop'], 'stop, nunca disconnect');
    assert.equal((await loginAs(world.app, 'novo.usuario@teste.local')).status, 401);
    // Reativar e trocar a senha: a nova vale, sessões antigas caem.
    assert.equal((await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${novoId}`, headers: h, payload: { disabled: false } })).json().disabledAt, null);
    const antes = await loginAs(world.app, 'novo.usuario@teste.local');
    assert.equal((await world.app.inject({ method: 'POST', url: `/api/admin/users/${novoId}/password`, headers: h, payload: { password: 'outra-senha-forte-1' } })).statusCode, 200);
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'localhost', cookie: antes.cookie } })).statusCode, 401);
    assert.equal((await loginAs(world.app, 'novo.usuario@teste.local', 'outra-senha-forte-1')).status, 200);
    // Travas: nada em si mesmo; nunca remover o último administrador ativo.
    assert.equal((await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${admin.user.id}`, headers: h, payload: { disabled: true } })).statusCode, 400);
    assert.equal((await world.app.inject({ method: 'POST', url: `/api/admin/users/${admin.user.id}/password`, headers: h, payload: { password: 'senha-de-teste-999' } })).statusCode, 400);
    const restore = await onlySuperAdmin(admin.user.id);
    try {
      const promovido = await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${novoId}`, headers: h, payload: { role: 'SUPER_ADMIN' } });
      assert.equal(promovido.json().role, 'SUPER_ADMIN');
      assert.equal((await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${novoId}`, headers: h, payload: { role: 'USER' } })).statusCode, 200, 'com dois ativos, pode rebaixar');
      // Com um único administrador ativo, ele não pode ser removido.
      await prisma.user.update({ where: { id: novoId }, data: { role: 'SUPER_ADMIN' } });
      await prisma.user.update({ where: { id: admin.user.id }, data: { disabledAt: new Date() } });
      const asNovo = await loginAs(world.app, 'novo.usuario@teste.local', 'outra-senha-forte-1');
      await prisma.user.update({ where: { id: admin.user.id }, data: { disabledAt: null, role: 'USER' } });
      const ultimo = await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${admin.user.id}`, headers: { host: 'localhost', origin: PANEL, cookie: asNovo.cookie }, payload: { role: 'SUPER_ADMIN' } });
      assert.equal(ultimo.statusCode, 200, 'promover outro é permitido');
      await prisma.user.update({ where: { id: admin.user.id }, data: { role: 'USER' } });
      const semSaida = await world.app.inject({ method: 'PATCH', url: `/api/admin/users/${novoId}`, headers: { host: 'localhost', origin: PANEL, cookie: asNovo.cookie }, payload: { disabled: true } });
      assert.equal(semSaida.statusCode, 400, 'o único administrador não se desativa');
      await prisma.user.update({ where: { id: admin.user.id }, data: { role: 'SUPER_ADMIN' } });
      await prisma.user.update({ where: { id: novoId }, data: { role: 'USER' } });
    } finally { await restore(); }
    assert.equal((await world.app.inject({ method: 'PATCH', url: '/api/admin/users/nao-existe', headers: h, payload: { disabled: true } })).statusCode, 404);
  } finally { await world.cleanup(); }
});

test('admin: concurrent demotions cannot remove both remaining active administrators', async () => {
  const world = whatsappApp();
  const a = await sessionFor(world.app, 'concorrente-a@teste.local', 'SUPER_ADMIN');
  const b = await sessionFor(world.app, 'concorrente-b@teste.local', 'SUPER_ADMIN');
  const restore = await onlySuperAdmin(a.user.id);
  try {
    await prisma.user.update({ where: { id: b.user.id }, data: { role: 'SUPER_ADMIN' } });
    const loginA = await loginAs(world.app, 'concorrente-a@teste.local');
    const loginB = await loginAs(world.app, 'concorrente-b@teste.local');
    const [removeB, removeA] = await Promise.all([
      world.app.inject({ method: 'PATCH', url: `/api/admin/users/${b.user.id}`, headers: as(loginA.cookie), payload: { role: 'USER' } }),
      world.app.inject({ method: 'PATCH', url: `/api/admin/users/${a.user.id}`, headers: as(loginB.cookie), payload: { role: 'USER' } }),
    ]);
    assert.deepEqual([removeB.statusCode, removeA.statusCode].sort(), [200, 400]);
    assert.equal(await prisma.user.count({ where: { role: 'SUPER_ADMIN', disabledAt: null } }), 1);
  } finally {
    await restore();
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'USER' } });
    await prisma.user.update({ where: { id: b.user.id }, data: { role: 'USER' } });
    await world.cleanup();
  }
});

// ─── Painel do administrador (ADR-031) ──────────────────────────────────────────
test('admin (031): the overview reports system-wide numbers, never a campaign or message', async () => {
  const world = whatsappApp();
  try {
    const admin = await sessionFor(world.app, 'visao-admin@teste.local', 'SUPER_ADMIN');
    const user = await sessionFor(world.app, 'visao-user@teste.local');
    const asAdmin = await loginAs(world.app, 'visao-admin@teste.local');
    const asUser = await loginAs(world.app, 'visao-user@teste.local');
    const h = { host: 'localhost', origin: PANEL, cookie: asAdmin.cookie };
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { host: 'localhost', origin: PANEL, cookie: asUser.cookie } })).statusCode, 403, 'USER não entra');
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { host: 'localhost', origin: PANEL } })).statusCode, 401);

    const group = await prisma.group.create({ data: { name: 'Segredo da campanha', userId: user.user.id } });
    const campaign = await prisma.campaign.create({ data: { name: 'Nome sigiloso', userId: user.user.id, startsAt: new Date(), endsAt: new Date(), status: 'ACTIVE', provider: 'baileys',
      groups: { create: [{ groupId: group.id, position: 0 }] }, messages: { create: [{ content: 'conteúdo sigiloso', position: 0 }] },
      deliveries: { create: [{ groupId: group.id, messageBody: 'conteúdo sigiloso', sequence: 0, scheduledAt: new Date(), provider: 'baileys', status: 'SENT', sentAt: new Date() }] } } });
    world.manager.for(user.user.id);
    world.perUser.get(user.user.id)!.state = { state: 'connected', accountJid: '5511999999999@s.whatsapp.net' };

    const overview = await world.app.inject({ method: 'GET', url: '/api/admin/overview', headers: h });
    assert.equal(overview.statusCode, 200, overview.body);
    for (const segredo of [group.name, campaign.name, 'conteúdo sigiloso', 'messageBody']) assert.ok(!overview.body.includes(segredo), `não expõe ${segredo}`);
    const body = overview.json();
    assert.ok(body.users.total >= 2 && body.users.active >= 2);
    assert.ok(body.campaigns.total >= 1 && body.campaigns.active >= 1);
    assert.ok(body.today.sent >= 1, 'o envio de hoje entra na contagem');
    assert.equal(body.last7Days.length, 7);
    assert.ok(body.whatsapp.connectedNow >= 1, 'a conexão simulada como conectada conta');
    assert.ok('dispatcher' in body && 'process' in body && typeof body.process.uptimeSeconds === 'number');
  } finally { await world.cleanup(); }
});

test('admin (031): force-logout and stop-WhatsApp act on the account without touching its campaigns', async () => {
  const world = whatsappApp();
  try {
    const admin = await sessionFor(world.app, 'acao-admin@teste.local', 'SUPER_ADMIN');
    const asAdmin = await loginAs(world.app, 'acao-admin@teste.local');
    const h = { host: 'localhost', origin: PANEL, cookie: asAdmin.cookie };
    const alvo = await sessionFor(world.app, 'acao-alvo@teste.local');
    const logged = await loginAs(world.app, 'acao-alvo@teste.local');
    world.manager.for(alvo.user.id);
    const group = await prisma.group.create({ data: { name: 'Do alvo', userId: alvo.user.id } });
    const campaign = await prisma.campaign.create({ data: { name: 'Ativa do alvo', userId: alvo.user.id, startsAt: new Date(), endsAt: new Date(), status: 'ACTIVE', groups: { create: [{ groupId: group.id, position: 0 }] } } });

    const out = await world.app.inject({ method: 'POST', url: `/api/admin/users/${alvo.user.id}/logout`, headers: h });
    assert.equal(out.statusCode, 200, out.body);
    assert.ok(out.json().sessionsEnded >= 1);
    assert.equal((await world.app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'localhost', cookie: logged.cookie } })).statusCode, 401, 'sessão derrubada');
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE', 'campanha não é pausada por um logout forçado');

    const stopped = await world.app.inject({ method: 'POST', url: `/api/admin/users/${alvo.user.id}/whatsapp/stop`, headers: h });
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.deepEqual(world.perUser.get(alvo.user.id)!.calls, ['stop']);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE', 'campanha não é pausada ao derrubar só o WhatsApp');
    assert.equal((await world.app.inject({ method: 'POST', url: '/api/admin/users/nao-existe/logout', headers: h })).statusCode, 404);
    assert.equal((await world.app.inject({ method: 'POST', url: '/api/admin/users/nao-existe/whatsapp/stop', headers: h })).statusCode, 404);
  } finally { await world.cleanup(); }
});

// ─── Intervalo mínimo de 2 minutos (ADR-028, 2 min desde a ADR-035) ─────────────
test('minimum interval (028): the API refuses less than 2 minutes and the queue never paces faster', async () => {
  const group = await prisma.group.create({ data: { name: 'Piso', userId: ownerId } });
  const base = { name: 'Piso', mode: 'IMMEDIATE', messages: ['oi'], groupIds: [group.id] };
  assert.equal((await request('POST', '/campaigns', { ...base, intervalSeconds: 119 })).statusCode, 400, '119 s: recusado');
  assert.match((await request('POST', '/campaigns', { ...base, intervalSeconds: 60 })).json().error, /mínimo de 2 minutos/);
  assert.equal((await request('POST', '/campaigns', { ...base, intervalSeconds: 120 })).statusCode, 201, '120 s: aceito');
  // Campanha com intervalo antigo de 60 s gravada direto no banco: a fila aplica o piso.
  const previous = process.env.SEND_INTERVAL_FLOOR_SECONDS;
  process.env.SEND_INTERVAL_FLOOR_SECONDS = '120';
  try {
    const { campaign, rows: [row] } = await realCampaign(1, 60);
    const at = new Date();
    assert.ok(await claimDelivery(prisma, row.id, at));
    const reserved = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    assert.equal(reserved.nextAvailableAt!.getTime(), at.getTime() + 120_000, 'reserva ocupa o número por 2 min, não 60 s');
    await finishDelivery(prisma, row.id, { providerId: '3EB0PISO', context: '' }, at);
    const number = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    assert.equal(number.nextAvailableAt!.getTime(), at.getTime() + 120_000, 'o número fica livre só 2 min depois');
    assert.equal(number.lastIntervalSeconds, 120);
    // Previsão do painel usa o mesmo piso.
    const { forecastQueue } = await import('./queue-forecast.js');
    const plan = forecastQueue([{ id: 'a', status: 'PENDING', sequence: 0, provider: 'baileys', scheduledAt: at, attemptedAt: null, attempts: 0 }, { id: 'b', status: 'PENDING', sequence: 1, provider: 'baileys', scheduledAt: at, attemptedAt: null, attempts: 0 }], { status: 'ACTIVE', nextAvailableAt: null, intervalSeconds: 60 }, at, true, 3);
    assert.equal(plan.get('b')!.expectedAt.getTime() - plan.get('a')!.expectedAt.getTime(), 120_000);
  } finally {
    if (previous === undefined) delete process.env.SEND_INTERVAL_FLOOR_SECONDS; else process.env.SEND_INTERVAL_FLOOR_SECONDS = previous;
  }
});

test('random interval (042): outside the test floor, each send waits a drawn 1:30 to 3:00, whatever the campaign says', async () => {
  const previous = process.env.SEND_INTERVAL_FLOOR_SECONDS;
  delete process.env.SEND_INTERVAL_FLOOR_SECONDS; // como em produção
  try {
    const waits = new Set<number>();
    for (let round = 0; round < 6; round++) {
      await resetPace();
      const { rows: [row] } = await realCampaign(1, 3600); // o intervalo gravado na campanha não conta mais
      const at = new Date();
      assert.ok(await claimDelivery(prisma, row.id, at));
      await finishDelivery(prisma, row.id, { providerId: `3EBSORTEIO${round}`, context: '' }, at);
      const number = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
      const wait = (number.nextAvailableAt!.getTime() - at.getTime()) / 1000;
      assert.ok(wait >= 90 && wait <= 180, `espera sorteada fora da faixa: ${wait} s`);
      assert.equal(number.lastIntervalSeconds, wait);
      waits.add(wait);
    }
    assert.ok(waits.size > 1, 'o intervalo muda de um envio para outro');
  } finally {
    if (previous === undefined) delete process.env.SEND_INTERVAL_FLOOR_SECONDS; else process.env.SEND_INTERVAL_FLOOR_SECONDS = previous;
  }
});

test('migration (real MySQL): campaigns below 3 minutes are raised to 3 minutes, nothing else changes', async () => {
  await withLegacyDatabase(async (db, apply, names) => {
    const target = '20260924180000_min_interval';
    for (const name of names.slice(0, names.indexOf(target))) await apply(name);
    await db.$executeRawUnsafe("INSERT INTO \`User\` (id, email, name, passwordHash, role, updatedAt) VALUES ('u1', 'u1@x', 'U', 'h', 'SUPER_ADMIN', NOW(3))");
    await db.$executeRawUnsafe("INSERT INTO \`Campaign\` (id, userId, name, startsAt, endsAt, intervalSeconds, updatedAt) VALUES ('rapida', 'u1', 'R', NOW(3), NOW(3), 60, NOW(3)), ('normal', 'u1', 'N', NOW(3), NOW(3), 300, NOW(3))");
    await apply(target);
    const rows = await db.$queryRawUnsafe<{ id: string; intervalSeconds: number }[]>('SELECT id, intervalSeconds FROM \`Campaign\` ORDER BY id');
    assert.deepEqual(rows.map(r => [r.id, Number(r.intervalSeconds)]), [['normal', 300], ['rapida', 180]]);
  });
});

// ─── Marcar todos (ADR-029) ─────────────────────────────────────────────────────
test('mention all (029): saved with the campaign, copied on reuse and passed to every send', async () => {
  const group = await prisma.group.create({ data: { name: 'Marcar', userId: ownerId } });
  const base = { name: 'Com todos', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['oi'], groupIds: [group.id] };
  assert.equal((await request('POST', '/campaigns', { ...base, mentionAll: 'sim' })).statusCode, 400, 'só booleano');
  const created = await request('POST', '/campaigns', { ...base, mentionAll: true });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await request('GET', `/campaigns/${created.json().id}`)).json().mentionAll, true);
  assert.equal((await request('POST', '/campaigns', base)).json().mentionAll, false, 'padrão: desligado');
  const copy = await request('POST', `/campaigns/${created.json().id}/duplicate`, {});
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: copy.json().id } })).mentionAll, true, 'usar de novo mantém a opção');
  // O despachante repassa a opção ao conector.
  const { campaign, rows: [row] } = await realCampaign(1);
  await prisma.campaign.update({ where: { id: campaign.id }, data: { mentionAll: true } });
  const options: unknown[] = [];
  const wa = fakeWhatsApp(async () => ({ messageId: '3EB0TODOS', context: 'x' }));
  const originalSend = (wa.provider as unknown as { send: (...args: unknown[]) => unknown }).send;
  (wa.provider as unknown as { send: (...args: unknown[]) => unknown }).send = (...args: unknown[]) => { options.push(args[5]); return originalSend(...args); };
  const dispatcher = await startDispatcher(wa.router, { scanIntervalMs: 50 });
  try { await waitFor(async () => (await fresh(row.id)).status === 'SENT', 'envio'); }
  finally { await dispatcher.stop(); }
  assert.deepEqual(options, [{ mentionAll: true }]);
});

// Bug de 2026-09-24: depois da migração da sessão, a previsão perguntava à conexão global
// legada (sempre desligada) e mostrava "WhatsApp desconectado" com o dono enviando normalmente.
test('forecast: "connected" is the campaign owner\'s connection, never the legacy global one', async () => {
  const world = whatsappApp({ legacyState: 'disconnected', legacyPaired: false });
  try {
    const owner = await sessionFor(world.app, 'previsao-dono@teste.local');
    const { cookie } = await loginAs(world.app, 'previsao-dono@teste.local');
    const group = await prisma.group.create({ data: { name: 'Previsão', userId: owner.user.id, externalId: `120355${Date.now()}@g.us` } });
    const later = new Date(Date.now() + 3_600_000);
    const campaign = await prisma.campaign.create({ data: { name: 'Previsão', userId: owner.user.id, startsAt: new Date(), endsAt: new Date(), status: 'ACTIVE', provider: 'baileys', accountJid: '5511900000001@s.whatsapp.net', mode: 'SCHEDULED',
      groups: { create: [{ groupId: group.id, position: 0 }] }, deliveries: { create: [{ groupId: group.id, messageBody: 'oi', provider: 'baileys', sequence: 0, scheduledAt: later }] } } });
    const reason = async () => (await world.app.inject({ method: 'GET', url: `/api/deliveries?campaignId=${campaign.id}`, headers: as(cookie) })).json()[0].wait?.reason ?? '';
    world.manager.for(owner.user.id);
    world.perUser.get(owner.user.id)!.state = { state: 'connected', accountJid: '5511900000001@s.whatsapp.net' };
    assert.doesNotMatch(await reason(), /desconectado/, 'dono conectado: nada de "desconectado", mesmo com a global desligada');
    world.perUser.get(owner.user.id)!.state = { state: 'disconnected' };
    assert.match(await reason(), /desconectado/, 'dono desconectado: aí sim avisa');
  } finally { await world.cleanup(); }
});

// ─── Tentar de novo (ADR-030) ────────────────────────────────────────────────────
test('retry (030): a safe failure retries straight away; an uncertain one needs confirmation first', async () => {
  const { rows: [certain, uncertain] } = await realCampaign(2);
  await prisma.delivery.update({ where: { id: certain.id }, data: { status: 'FAILED', error: 'Só administradores podem enviar neste grupo.', errorCode: 'grupo:so-admins' } });
  await prisma.delivery.update({ where: { id: uncertain.id }, data: { status: 'FAILED', error: 'Timed Out. Resultado incerto: confira no celular. Sem reenvio automático para não duplicar.', errorCode: 'ETIMEDOUT' } });

  // Falha certa: tenta de novo direto, sem precisar confirmar nada.
  const safe = await request('POST', `/deliveries/${certain.id}/retry`, {});
  assert.equal(safe.statusCode, 200, safe.body);
  assert.deepEqual(safe.json(), { retried: true });
  const requeued = await fresh(certain.id);
  assert.equal(requeued.status, 'PENDING'); assert.equal(requeued.error, null); assert.equal(requeued.errorCode, null);

  // Falha incerta: primeiro pedido volta 409 pedindo confirmação; nada muda ainda.
  const blocked = await request('POST', `/deliveries/${uncertain.id}/retry`, {});
  assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().uncertain, true);
  assert.equal((await fresh(uncertain.id)).status, 'FAILED', 'sem confirmação, nada muda');
  const confirmed = await request('POST', `/deliveries/${uncertain.id}/retry`, { confirmUncertain: true });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal((await fresh(uncertain.id)).status, 'PENDING');

  // Só FAILED pode ser tentado de novo.
  await prisma.delivery.update({ where: { id: certain.id }, data: { status: 'SENT' } });
  assert.equal((await request('POST', `/deliveries/${certain.id}/retry`, {})).statusCode, 400);
});

test('retry (030): blocked for another user\'s delivery or a cancelled campaign; a completed campaign reactivates', async () => {
  const other = await prisma.user.create({ data: { email: `outro-retry-${Date.now()}@teste.local`, name: 'Outro', passwordHash: 'x' } });
  const group = await prisma.group.create({ data: { name: 'De outro', userId: other.id } });
  const foreignCampaign = await prisma.campaign.create({ data: { name: 'De outro', userId: other.id, startsAt: new Date(), endsAt: new Date(), status: 'ACTIVE', mode: 'IMMEDIATE',
    groups: { create: [{ groupId: group.id, position: 0 }] }, deliveries: { create: [{ groupId: group.id, messageBody: 'oi', sequence: 0, scheduledAt: new Date(), status: 'FAILED', error: 'x' }] } } });
  const foreignDelivery = await prisma.delivery.findFirstOrThrow({ where: { campaignId: foreignCampaign.id } });
  assert.equal((await request('POST', `/deliveries/${foreignDelivery.id}/retry`, {})).statusCode, 404, 'entrega de outro dono não existe para mim');

  const { campaign, rows: [row] } = await realCampaign(1);
  await prisma.delivery.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'Recusado.' } });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'CANCELLED' } });
  assert.equal((await request('POST', `/deliveries/${row.id}/retry`, {})).statusCode, 400, 'campanha encerrada não reabre por aqui');
  assert.equal((await request('POST', `/campaigns/${campaign.id}/retry-failed`, {})).statusCode, 400);

  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED' } });
  assert.equal((await request('POST', `/deliveries/${row.id}/retry`, {})).statusCode, 200);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE', 'volta a ativa para o despachante olhar de novo');
});

test('retry (030): retrying all failures in a campaign skips the uncertain ones and reports both counts', async () => {
  const { campaign, rows: [a, b, c] } = await realCampaign(3);
  await prisma.delivery.update({ where: { id: a.id }, data: { status: 'FAILED', error: 'Recusado.' } });
  await prisma.delivery.update({ where: { id: b.id }, data: { status: 'FAILED', error: 'Resultado incerto: confira no celular.' } });
  await prisma.delivery.update({ where: { id: c.id }, data: { status: 'SENT' } });
  const result = await request('POST', `/campaigns/${campaign.id}/retry-failed`, {});
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { retried: 1, uncertainSkipped: 1 });
  assert.equal((await fresh(a.id)).status, 'PENDING');
  assert.equal((await fresh(b.id)).status, 'FAILED', 'incerta não entra no lote');
  assert.equal((await fresh(c.id)).status, 'SENT');
});

test('retry: two failed rounds for the same group keep distinct scheduled identities', async () => {
  const group = await prisma.group.create({ data: { name: 'Duas rodadas', userId: ownerId } });
  const now = Date.now();
  const times = [new Date(now - 240_000), new Date(now - 120_000)];
  const campaign = await prisma.campaign.create({ data: {
    name: 'Duas rodadas', userId: ownerId, startsAt: times[0], endsAt: times[1],
    status: 'COMPLETED', mode: 'SCHEDULED',
    groups: { create: [{ groupId: group.id, position: 0 }] },
    deliveries: { create: times.map((scheduledAt, sequence) => ({
      groupId: group.id, messageBody: 'oi', sequence, scheduledAt,
      status: 'FAILED', error: 'Recusado antes do envio.',
    })) },
  } });

  const result = await request('POST', `/campaigns/${campaign.id}/retry-failed`, {});
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().retried, 2);
  const rows = await prisma.delivery.findMany({ where: { campaignId: campaign.id }, orderBy: { sequence: 'asc' } });
  assert.deepEqual(rows.map(row => row.status), ['PENDING', 'PENDING']);
  assert.deepEqual(rows.map(row => row.scheduledAt.getTime()), times.map(time => time.getTime()));
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE');
});

test('retry: two simultaneous requests can requeue a failed delivery only once', async () => {
  const { rows: [delivery] } = await realCampaign(1);
  await prisma.delivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', error: 'Recusado antes do envio.' } });

  const responses = await Promise.all([
    request('POST', `/deliveries/${delivery.id}/retry`, {}),
    request('POST', `/deliveries/${delivery.id}/retry`, {}),
  ]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 400]);
  assert.equal((await fresh(delivery.id)).status, 'PENDING');
});

// Por último: apaga os usuários deste banco de teste para simular a primeira subida.
// ─── LGPD (ADR-040) ─────────────────────────────────────────────────────────────
async function lgpdUser(email: string, role: 'USER' | 'SUPER_ADMIN' = 'USER') {
  const user = await prisma.user.create({ data: { email, name: email.split('@')[0], role, passwordHash: await hashPassword('senha-de-teste-123') } });
  const { cookie: session } = await loginAs(app, email);
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: as(session) });
  return { user, session, call };
}
async function lgpdCampaign(userId: string, name: string, data: { status?: 'DRAFT' | 'COMPLETED' | 'CANCELLED' | 'ACTIVE'; deletedAt?: Date; mediaId?: string } = {}) {
  const group = await prisma.group.create({ data: { name: `${name} grupo`, userId } });
  return prisma.campaign.create({ data: {
    userId, name, startsAt: new Date(), endsAt: new Date(), status: data.status ?? 'DRAFT', deletedAt: data.deletedAt, mediaId: data.mediaId,
    groups: { create: [{ groupId: group.id, position: 0 }] }, messages: { create: [{ content: `texto de ${name}`, position: 0 }] },
  } });
}

test('LGPD: public legal info, terms acceptance is required once per version', async () => {
  const legal = await app.inject({ method: 'GET', url: '/api/legal', headers: { host: 'localhost' } });
  assert.equal(legal.statusCode, 200, 'abre sem login');
  assert.equal(legal.json().product, 'DocDrop');
  assert.equal(legal.json().retentionDays, 180);
  const { call } = await lgpdUser('termos@teste.local');
  assert.equal((await call('GET', '/api/auth/me')).json().user.termsPending, true, 'conta nova precisa aceitar');
  const accepted = await call('POST', '/api/account/terms', {});
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await call('GET', '/api/auth/me')).json().user.termsPending, false);
  const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'termos@teste.local' } });
  assert.ok(stored.termsAcceptedAt, 'guarda quando aceitou');
  assert.ok(stored.termsVersion, 'e qual versão');
});

test('LGPD: export brings only the account own data, as a download', async () => {
  const a = await lgpdUser('exporta-a@teste.local');
  const b = await lgpdUser('exporta-b@teste.local');
  await lgpdCampaign(a.user.id, 'Festa da A');
  await lgpdCampaign(b.user.id, 'Festa da B');
  const r = await a.call('GET', '/api/account/export');
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-disposition']), /attachment; filename="docdrop-meus-dados-/);
  const data = r.json();
  assert.equal(data.conta.email, 'exporta-a@teste.local');
  assert.equal(data.conta.passwordHash, undefined, 'nunca a senha, nem cifrada');
  assert.deepEqual(data.campanhas.map((c: { name: string }) => c.name), ['Festa da A']);
  assert.deepEqual(data.campanhas[0].mensagens, ['texto de Festa da A']);
  assert.doesNotMatch(r.body, /Festa da B/);
});

test('LGPD: deleting the account needs the password and erases everything of that account only', async () => {
  const a = await lgpdUser('exclui-a@teste.local');
  const b = await lgpdUser('exclui-b@teste.local');
  const media = await prisma.campaignMedia.create({ data: { userId: a.user.id, name: 'arte.png', mimeType: 'image/png', kind: 'image', size: 1, data: Buffer.from([1]) } });
  await lgpdCampaign(a.user.id, 'Some', { mediaId: media.id });
  const other = await lgpdCampaign(b.user.id, 'Fica');
  const dir = whatsappSessionDir(a.user.id, suiteSessions);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'creds.json'), '{}');

  assert.equal((await a.call('POST', '/api/account/delete', { password: 'errada-123456' })).statusCode, 400, 'senha errada não exclui');
  const deleted = await a.call('POST', '/api/account/delete', { password: 'senha-de-teste-123' });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.match(String(deleted.headers['set-cookie']), /Max-Age=0/, 'apaga o cookie');
  assert.equal(await prisma.user.count({ where: { id: a.user.id } }), 0);
  for (const count of [prisma.campaign.count({ where: { userId: a.user.id } }), prisma.group.count({ where: { userId: a.user.id } }), prisma.campaignMedia.count({ where: { userId: a.user.id } }), prisma.authSession.count({ where: { userId: a.user.id } })]) assert.equal(await count, 0);
  assert.equal(existsSync(dir), false, 'pasta do WhatsApp apagada');
  assert.equal((await a.call('GET', '/api/auth/me')).statusCode, 401);
  assert.ok(await prisma.campaign.findUnique({ where: { id: other.id } }), 'a outra conta fica intacta');

  const admin = await lgpdUser('exclui-admin@teste.local', 'SUPER_ADMIN');
  assert.equal((await admin.call('POST', '/api/account/delete', { password: 'senha-de-teste-123' })).statusCode, 400, 'administrador não se exclui');
  // Pedido recebido pelo canal de contato: o administrador exclui a conta de um usuário.
  assert.equal((await b.call('DELETE', `/api/admin/users/${admin.user.id}`)).statusCode, 403, 'usuário comum não usa a rota do admin');
  const byAdmin = await admin.call('DELETE', `/api/admin/users/${b.user.id}`);
  assert.equal(byAdmin.statusCode, 200, byAdmin.body);
  assert.equal(await prisma.campaign.count({ where: { id: other.id } }), 0);
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: 'USER', disabledAt: new Date() } });
});

test('account deletion rejects a password changed after confirmation and preserves all data', async () => {
  const { user } = await lgpdUser('delete-stale-password@teste.local');
  const campaign = await lgpdCampaign(user.id, 'Preservada');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword('senha-nova-de-teste-123') } });
  let disconnected = false;
  await assert.rejects(deleteAccount(user.id, {
    disconnect: async () => { disconnected = true; },
    sessionDirFor: id => whatsappSessionDir(id, suiteSessions),
  }, user.passwordHash), /senha foi alterada/i);
  assert.ok(await prisma.user.findUnique({ where: { id: user.id } }));
  assert.ok(await prisma.campaign.findUnique({ where: { id: campaign.id } }));
  assert.equal(disconnected, false);
});

test('account deletion waits for a concurrent role change and cannot delete a promoted administrator', async () => {
  const { user } = await lgpdUser('delete-promoted@teste.local');
  let locked!: () => void;
  let release!: () => void;
  const hasLock = new Promise<void>(resolve => { locked = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  const promotion = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`;
    locked();
    await unlock;
    await tx.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
  });
  await hasLock;
  let disconnected = false;
  const deletion = assert.rejects(deleteAccount(user.id, {
    disconnect: async () => { disconnected = true; },
    sessionDirFor: id => whatsappSessionDir(id, suiteSessions),
  }), /administrador não pode ser excluída/i);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    await promotion;
    await deletion;
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role, 'SUPER_ADMIN');
    assert.equal(disconnected, false);
  } finally {
    release();
    await promotion;
    await prisma.user.updateMany({ where: { id: user.id }, data: { role: 'USER', disabledAt: new Date() } });
  }
});

test('LGPD: retention sweep erases deleted and 6-month-old finished campaigns, orphan media and old gone groups', async () => {
  const { user } = await lgpdUser('prazo@teste.local');
  const now = new Date();
  const old = new Date(now.getTime() - 200 * 86_400_000);
  const expired = await lgpdCampaign(user.id, 'Velha', { status: 'COMPLETED' });
  const recent = await lgpdCampaign(user.id, 'Recente', { status: 'COMPLETED' });
  const removed = await lgpdCampaign(user.id, 'Excluída', { status: 'CANCELLED', deletedAt: now });
  const running = await lgpdCampaign(user.id, 'Rodando', { status: 'ACTIVE' });
  await prisma.$executeRaw`UPDATE \`Campaign\` SET updatedAt = ${old} WHERE id IN (${expired.id}, ${running.id})`;
  const orphanOld = await prisma.campaignMedia.create({ data: { userId: user.id, name: 'velha.png', mimeType: 'image/png', kind: 'image', size: 1, data: Buffer.from([1]), createdAt: old } });
  const orphanNew = await prisma.campaignMedia.create({ data: { userId: user.id, name: 'nova.png', mimeType: 'image/png', kind: 'image', size: 1, data: Buffer.from([1]) } });
  const gone = await prisma.group.create({ data: { userId: user.id, name: 'Saiu', externalId: 'saiu@g.us', active: false } });
  await prisma.$executeRaw`UPDATE \`Group\` SET updatedAt = ${old} WHERE id = ${gone.id}`;

  const result = await purgeExpiredData(now, { userId: user.id });
  assert.equal(result.campaigns, 2, JSON.stringify(result));
  const left = (await prisma.campaign.findMany({ where: { userId: user.id }, select: { id: true } })).map(c => c.id).sort();
  assert.deepEqual(left, [recent.id, running.id].sort(), 'ativa e recente ficam; velha e excluída saem');
  assert.equal(await prisma.campaign.count({ where: { id: removed.id } }), 0);
  assert.equal(await prisma.campaignMedia.count({ where: { id: orphanOld.id } }), 0, 'mídia sem campanha, antiga, sai');
  assert.equal(await prisma.campaignMedia.count({ where: { id: orphanNew.id } }), 1, 'recém-enviada fica (o formulário pode estar aberto)');
  assert.equal(await prisma.group.count({ where: { id: gone.id } }), 0, 'grupo que saiu há 6 meses sai');
});

// ─── Sugestões e críticas, relatório e números por dia (ADR-045) ────────────────
test('feedback: each user sees only their own; the admin sees all, replies and sets the status', async () => {
  const a = await lgpdUser('opina-a@teste.local');
  const b = await lgpdUser('opina-b@teste.local');
  const admin = await lgpdUser('opina-admin@teste.local', 'SUPER_ADMIN');
  assert.equal((await a.call('POST', '/api/feedback', { kind: 'outro', message: 'texto longo o bastante' })).statusCode, 400, 'tipo inválido');
  assert.equal((await a.call('POST', '/api/feedback', { kind: 'sugestao', message: 'curto' })).statusCode, 400, 'curto demais');
  const sent = await a.call('POST', '/api/feedback', { kind: 'sugestao', message: 'Queria agendar o status do WhatsApp.', userId: b.user.id });
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal((await prisma.feedback.findUniqueOrThrow({ where: { id: sent.json().id } })).userId, a.user.id, 'o dono vem da sessão, não do corpo');
  await b.call('POST', '/api/feedback', { kind: 'problema', message: 'O botão não respondeu no celular.' });

  const mine = (await a.call('GET', '/api/feedback')).json();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'novo');
  assert.equal((await a.call('GET', '/api/admin/feedback')).statusCode, 403, 'usuário comum não lê o de todos');

  const all = (await admin.call('GET', '/api/admin/feedback')).json();
  const item = all.items.find((f: { id: string }) => f.id === sent.json().id);
  assert.equal(item.user.email, 'opina-a@teste.local');
  assert.ok(all.counts.novo >= 2);
  const patch = (payload: object, session = admin.session) => app.inject({ method: 'PATCH', url: `/api/admin/feedback/${item.id}`, payload, headers: as(session) });
  assert.equal((await patch({ status: 'feito' }, a.session)).statusCode, 403);
  assert.equal((await patch({ status: 'qualquer' })).statusCode, 400);
  const answered = await patch({ status: 'analisando', reply: 'Boa ideia, entrou na fila.' });
  assert.equal(answered.statusCode, 200, answered.body);
  const seen = (await a.call('GET', '/api/feedback')).json()[0];
  assert.equal(seen.status, 'analisando');
  assert.equal(seen.reply, 'Boa ideia, entrou na fila.');
  assert.ok(seen.repliedAt);
  assert.equal((await b.call('GET', '/api/feedback')).json().some((f: { reply: string | null }) => f.reply), false, 'a resposta não aparece para outra conta');

  // Limite suave: 5 por hora por conta.
  for (let i = 0; i < 4; i++) await a.call('POST', '/api/feedback', { kind: 'elogio', message: `Mensagem de teste número ${i}.` });
  assert.equal((await a.call('POST', '/api/feedback', { kind: 'elogio', message: 'A sexta mensagem na mesma hora.' })).statusCode, 429);
  assert.ok((await a.call('GET', '/api/account/export')).json().sugestoes.length >= 5, 'entra na exportação da LGPD');
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: 'USER', disabledAt: new Date() } });
});

test('report: owner numbers, a public link with numbers only, revocable; day numbers per account', async () => {
  const { user, campaign, delivery } = await protectedQueue('relatorio@teste.local', {});
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword('senha-de-teste-123') } });
  const { cookie: session } = await loginAs(app, 'relatorio@teste.local');
  const other = await lgpdUser('relatorio-outro@teste.local');
  const now = new Date();
  const first = await delivery(0, { scheduledAt: new Date(now.getTime() - 5000), status: 'SENT', sentAt: now, attemptedAt: now });
  await prisma.delivery.update({ where: { id: first.id }, data: { deliveredAt: now, messageBody: 'texto-secreto-da-campanha' } });
  await prisma.deliveryRead.create({ data: { deliveryId: first.id, recipientHash: 'h1', readAt: now } });
  await delivery(1, { scheduledAt: new Date(now.getTime() - 4000), status: 'SENT', sentAt: now, attemptedAt: now });
  const failed = await delivery(2, { scheduledAt: new Date(now.getTime() - 3000) });
  await prisma.delivery.update({ where: { id: failed.id }, data: { status: 'FAILED', error: 'x' } });
  await delivery(3, { scheduledAt: new Date(now.getTime() + 3_600_000) });

  const url = `/api/campaigns/${campaign.id}/report`;
  const mine = await app.inject({ method: 'GET', url, headers: as(session) });
  assert.equal(mine.statusCode, 200, mine.body);
  const t = mine.json().totals;
  assert.deepEqual([t.sent, t.delivered, t.failed, t.pending, t.reads, t.groups, t.groupsReached], [2, 1, 1, 1, 1, 1, 1]);
  assert.equal(t.deliveryRate, 50);
  assert.equal(mine.json().shareToken, null);
  assert.equal((await other.call('GET', url)).statusCode, 404, 'campanha de outra conta: como se não existisse');
  assert.equal((await other.call('POST', `${url}/share`, {})).statusCode, 404);

  const shared = await app.inject({ method: 'POST', url: `${url}/share`, payload: {}, headers: as(session) });
  const token = shared.json().shareToken as string;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await app.inject({ method: 'POST', url: `${url}/share`, payload: {}, headers: as(session) })).json().shareToken, token, 'o mesmo link continua valendo');
  // Sem login: só números. Nada de texto de mensagem, ids internos ou do dono.
  const open = await app.inject({ method: 'GET', url: `/api/public/report/${token}`, headers: { host: 'localhost' } });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().totals.sent, 2);
  for (const secret of ['texto-secreto-da-campanha', campaign.id, user.id, 'relatorio@teste.local', 'shareToken', campaign.accountJid!]) assert.ok(!open.body.includes(secret), `o link não expõe ${secret}`);
  assert.equal((await app.inject({ method: 'GET', url: '/api/public/report/codigo-que-nao-existe-123456', headers: { host: 'localhost' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `${url}/share`, headers: as(session) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/public/report/${token}`, headers: { host: 'localhost' } })).statusCode, 404, 'link desativado');

  // Números do dia (clique no gráfico do Início), só da própria conta.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  const day = await app.inject({ method: 'GET', url: `/api/dashboard/day?date=${today}`, headers: as(session) });
  assert.equal(day.statusCode, 200, day.body);
  assert.deepEqual([day.json().sent, day.json().delivered, day.json().reads, day.json().groupsReached], [2, 1, 1, 1]);
  assert.equal(day.json().campaigns[0].name, 'Protegida');
  assert.equal(day.json().hours.reduce((sum: number, h: { sent: number }) => sum + h.sent, 0), 2);
  assert.equal((await other.call('GET', `/api/dashboard/day?date=${today}`)).json().sent, 0);
  for (const bad of ['2026-13-40', 'ontem', '2999-01-01', '2020-01-01']) assert.equal((await app.inject({ method: 'GET', url: `/api/dashboard/day?date=${bad}`, headers: as(session) })).statusCode, 400, bad);
});

// ─── Esqueci minha senha, modelos e listas de grupos (ADR-047) ──────────────────
const fromIp = (remoteAddress: string, email: string) => app.inject({ method: 'POST', url: '/api/auth/forgot', headers: anon, remoteAddress, payload: { email } });

test('forgot password: same answer for any e-mail; the admin issues a single-use link that ends the old sessions', async () => {
  const owner = await lgpdUser('esqueceu@teste.local');
  const admin = await lgpdUser('esqueceu-admin@teste.local', 'SUPER_ADMIN');
  const unknown = await fromIp('198.51.100.21', 'ninguem@teste.local');
  const known = await fromIp('198.51.100.22', 'ESQUECEU@teste.local ');
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual(known.json(), unknown.json(), 'a resposta não revela se a conta existe');
  assert.equal(known.json().delivery, 'admin', 'sem e-mail configurado, o administrador entrega o link');
  await fromIp('198.51.100.23', 'esqueceu@teste.local');
  assert.equal(await prisma.passwordReset.count({ where: { userId: owner.user.id } }), 1, 'um pedido por conta, sem acumular');
  assert.equal(await prisma.passwordReset.count({ where: { user: { email: 'ninguem@teste.local' } } }), 0);

  const listed = () => admin.call('GET', '/api/admin/users').then(r => r.json().find((u: { id: string }) => u.id === owner.user.id));
  assert.ok((await listed()).passwordResetRequestedAt, 'o administrador vê o pedido');
  const linkUrl = `/api/admin/users/${owner.user.id}/reset-link`;
  assert.equal((await owner.call('POST', linkUrl, {})).statusCode, 403, 'só o administrador gera link');
  assert.equal((await admin.call('POST', `/api/admin/users/${admin.user.id}/reset-link`, {})).statusCode, 400, 'não para a própria conta');
  const issued = await admin.call('POST', linkUrl, {});
  assert.equal(issued.statusCode, 200, issued.body);
  assert.equal((await listed()).passwordResetRequestedAt, null, 'pedido atendido');
  const token = String(issued.json().url).split('/redefinir-senha/')[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const stored = await prisma.passwordReset.findFirstOrThrow({ where: { userId: owner.user.id } });
  assert.notEqual(stored.tokenHash, token, 'o banco guarda só o hash do código');

  const open = (method: 'GET' | 'POST', code: string, payload?: object) => app.inject({ method, url: `/api/auth/reset/${code}`, headers: anon, payload });
  assert.equal((await open('GET', token)).json().name, 'esqueceu');
  assert.equal((await open('GET', 'codigo-inventado-com-tamanho-suficiente-1234567')).statusCode, 404);
  assert.equal((await open('POST', token, { password: 'curta' })).statusCode, 400);
  assert.equal((await open('POST', token, { password: 'senha-nova-bem-forte-1' })).statusCode, 200);
  assert.equal((await owner.call('GET', '/api/auth/me')).statusCode, 401, 'as sessões antigas caem');
  assert.equal((await loginAs(app, 'esqueceu@teste.local')).status, 401, 'a senha antiga não entra mais');
  assert.equal((await loginAs(app, 'esqueceu@teste.local', 'senha-nova-bem-forte-1')).status, 200);
  assert.equal((await open('POST', token, { password: 'outra-senha-forte-22' })).statusCode, 404, 'o link só funciona uma vez');
  assert.equal(await prisma.passwordReset.count({ where: { userId: owner.user.id } }), 0);

  // Link vencido não vale.
  const again = String((await admin.call('POST', linkUrl, {})).json().url).split('/redefinir-senha/')[1];
  await prisma.passwordReset.updateMany({ where: { userId: owner.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await open('GET', again)).statusCode, 404);
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: 'USER', disabledAt: new Date() } });
});

test('forgot password: with e-mail configured the link goes by e-mail, and asking too much is rate limited', async () => {
  await prisma.user.create({ data: { email: 'esqueceu-email@teste.local', name: 'Maria Souza', passwordHash: await hashPassword('senha-de-teste-123') } });
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailApp = Fastify();
  const config = loadConfig({});
  registerAuth(mailApp, config);
  registerPasswordReset(mailApp, config, { send: async message => { sent.push(message); } });
  const ask = (email: string) => mailApp.inject({ method: 'POST', url: '/api/auth/forgot', headers: anon, payload: { email } });
  try {
    const answer = await ask('esqueceu-email@teste.local');
    assert.deepEqual(answer.json(), { ok: true, delivery: 'email' });
    assert.deepEqual((await ask('ninguem-aqui@teste.local')).json(), { ok: true, delivery: 'email' });
    await waitFor(async () => sent.length === 1, 'e-mail enviado só para a conta que existe');
    assert.equal(sent[0].to, 'esqueceu-email@teste.local');
    assert.match(sent[0].text, /Olá, Maria Souza/);
    const token = sent[0].text.match(/\/redefinir-senha\/([A-Za-z0-9_-]+)/)![1];
    assert.equal((await mailApp.inject({ method: 'GET', url: `/api/auth/reset/${token}`, headers: anon })).statusCode, 200);
    const stored = await prisma.passwordReset.findFirstOrThrow({ where: { user: { email: 'esqueceu-email@teste.local' } } });
    assert.ok(stored.expiresAt!.getTime() - Date.now() <= 60 * 60_000, 'por e-mail vale 1 hora');
    // 5 pedidos do mesmo lugar em 15 minutos; o 6º espera.
    for (let i = 0; i < 3; i++) await ask(`outro-${i}@teste.local`);
    assert.equal((await ask('mais-um@teste.local')).statusCode, 429);
  } finally { await mailApp.close(); }
});

test('templates: saved from a campaign, kept out of the campaign list, never sent, and used to start a new draft', async () => {
  const owner = await lgpdUser('modelos@teste.local');
  const other = await lgpdUser('modelos-outro@teste.local');
  const group = await prisma.group.create({ data: { name: 'Do modelo', userId: owner.user.id, externalId: 'modelo@g.us' } });
  const base = { name: 'Sexta', mode: 'IMMEDIATE', messages: ['*Sexta* é aqui'], groupIds: [group.id] };
  const created = await owner.call('POST', '/api/campaigns', base);
  assert.equal(created.statusCode, 201, created.body);
  const duplicate = (id: string, payload: object, who = owner) => who.call('POST', `/api/campaigns/${id}/duplicate`, payload);

  const saved = await duplicate(created.json().id, { asTemplate: true });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().name, 'Sexta', 'o modelo guarda o nome, sem numerar');
  const templateId = saved.json().id as string;
  const templates = (await owner.call('GET', '/api/templates')).json();
  assert.deepEqual(templates.map((t: { id: string; name: string; groupCount: number; preview: string }) => [t.id, t.name, t.groupCount, t.preview]), [[templateId, 'Sexta', 1, '*Sexta* é aqui']]);
  assert.deepEqual((await owner.call('GET', '/api/campaigns')).json().items.map((c: { id: string }) => c.id), [created.json().id], 'o modelo não aparece entre as campanhas');
  assert.deepEqual((await other.call('GET', '/api/templates')).json(), [], 'modelos são de cada conta');
  assert.equal((await duplicate(templateId, {}, other)).statusCode, 404);

  // Um modelo não é enviado, encerrado nem reagendado.
  const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/campaigns/${id}`, payload, headers: as(owner.session) });
  const status = await app.inject({ method: 'PATCH', url: `/api/campaigns/${templateId}/status`, payload: { status: 'ACTIVE', provider: 'simulator' }, headers: as(owner.session) });
  assert.equal(status.statusCode, 400);
  assert.match(status.json().error, /modelo não é enviado/);
  assert.equal((await duplicate(templateId, { reschedule: true })).statusCode, 400);

  // Editar um modelo não esbarra em data passada (as datas são refeitas ao usar); uma campanha sim.
  const past = { ...base, mode: 'SCHEDULED', startsAt: '2026-01-05', endsAt: '2026-01-07', times: ['09:00'] };
  assert.equal((await patch(created.json().id, past)).statusCode, 400, 'campanha comum: data passada é recusada');
  assert.equal((await patch(templateId, past)).statusCode, 200, 'modelo: aceita');

  // Usar o modelo: campanha nova em rascunho, com as datas a partir de hoje e o mesmo período.
  const used = await duplicate(templateId, {});
  assert.equal(used.statusCode, 201, used.body);
  assert.equal(used.json().name, 'Sexta (2)', 'já existe a campanha "Sexta"');
  const draft = await prisma.campaign.findUniqueOrThrow({ where: { id: used.json().id }, include: { groups: true, messages: true, schedules: true } });
  assert.deepEqual([draft.isTemplate, draft.status, draft.mode, draft.groups.length, draft.messages[0].content, draft.schedules[0].time], [false, 'DRAFT', 'SCHEDULED', 1, '*Sexta* é aqui', '09:00']);
  assert.ok(draft.startsAt.getTime() > Date.now() - 2 * 86_400_000, 'começa hoje, não em janeiro');
  assert.equal(draft.endsAt.getTime() - draft.startsAt.getTime(), 2 * 86_400_000, 'mantém a duração do período');
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: templateId } })).isTemplate, true, 'o modelo fica como estava');
  // Datas FUTURAS no modelo também não valem: são só as da campanha de onde ele saiu.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await patch(templateId, { ...past, startsAt: day(30), endsAt: day(31) })).statusCode, 200);
  const later = await prisma.campaign.findUniqueOrThrow({ where: { id: (await duplicate(templateId, {})).json().id } });
  assert.ok(later.startsAt.getTime() < Date.now() + 2 * 86_400_000, 'começa hoje, não daqui a um mês');
  assert.equal(later.endsAt.getTime() - later.startsAt.getTime(), 86_400_000);

  // Excluir o modelo usa a mesma rota das campanhas.
  assert.equal((await owner.call('DELETE', `/api/campaigns/${templateId}`)).statusCode, 200);
  assert.deepEqual((await owner.call('GET', '/api/templates')).json(), []);
});

test('group lists: named sets of the account own groups, with rename, replace and delete', async () => {
  const owner = await lgpdUser('listas@teste.local');
  const other = await lgpdUser('listas-outro@teste.local');
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(name => prisma.group.create({ data: { name, userId: owner.user.id, externalId: `lista-${name}@g.us` } })));
  const theirs = await prisma.group.create({ data: { name: 'De outro', userId: other.user.id } });
  const post = (payload: object, who = owner) => who.call('POST', '/api/group-lists', payload);
  assert.equal((await post({ name: '  ', groupIds: [a.id] })).statusCode, 400);
  assert.equal((await post({ name: 'Vazia', groupIds: [] })).statusCode, 400);
  assert.equal((await post({ name: 'Com alheio', groupIds: [a.id, theirs.id] })).statusCode, 400, 'grupo de outra conta não entra');
  const made = await post({ name: ' Universitários ', groupIds: [a.id, b.id, a.id] });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json().name, 'Universitários');
  assert.deepEqual(made.json().groupIds.sort(), [a.id, b.id].sort());
  assert.equal((await post({ name: 'Universitários', groupIds: [c.id] })).statusCode, 409, 'nome repetido');
  assert.deepEqual((await other.call('GET', '/api/group-lists')).json(), [], 'listas são de cada conta');

  const id = made.json().id as string;
  const patch = (payload: object, session = owner.session) => app.inject({ method: 'PATCH', url: `/api/group-lists/${id}`, payload, headers: as(session) });
  assert.equal((await patch({ name: 'Minha agora' }, other.session)).statusCode, 404);
  const changed = await patch({ name: 'Sertanejo', groupIds: [c.id] });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual([changed.json().name, changed.json().groupIds], ['Sertanejo', [c.id]]);
  assert.deepEqual((await owner.call('GET', '/api/account/export')).json().listasDeGrupos.map((l: { nome: string; grupos: string[] }) => [l.nome, l.grupos]), [['Sertanejo', ['C']]]);
  // Grupo apagado some da lista sozinho.
  await prisma.group.delete({ where: { id: c.id } });
  assert.deepEqual((await owner.call('GET', '/api/group-lists')).json()[0].groupIds, []);
  assert.equal((await other.call('DELETE', `/api/group-lists/${id}`)).statusCode, 404);
  assert.equal((await owner.call('DELETE', `/api/group-lists/${id}`)).statusCode, 200);
  assert.deepEqual((await owner.call('GET', '/api/group-lists')).json(), []);
});

// ─── Avisos no WhatsApp do dono (ADR-048) ───────────────────────────────────────
test('owner alerts (048): preference per account, phone normalized, and the test notice goes to the saved destination', async () => {
  const owner = await lgpdUser('avisos@teste.local');
  const other = await lgpdUser('avisos-outro@teste.local');
  const put = (payload: object, who = owner) => app.inject({ method: 'PUT', url: '/api/alerts', payload, headers: as(who.session) });
  assert.deepEqual((await owner.call('GET', '/api/alerts')).json(), { enabled: false, phone: null, connected: false, recent: [] });
  assert.equal((await put({ phone: null })).statusCode, 400, 'ligado ou desligado é obrigatório');
  assert.equal((await put({ enabled: true, phone: '123' })).statusCode, 400, 'número curto demais');
  assert.equal(parsePhone('+55 (011) 91234-5678'), '5511912345678');
  assert.equal(parsePhone(''), null, 'vazio = o próprio número conectado');
  assert.throws(() => parsePhone('abc'), /inválido/);

  const saved = await put({ enabled: true, phone: '(11) 91234-5678' });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual([saved.json().enabled, saved.json().phone], [true, '5511912345678'], 'DDD + número ganha o 55');
  const since = (await prisma.alertSettings.findUniqueOrThrow({ where: { userId: owner.user.id } })).enabledAt;
  assert.ok(since, 'ligar marca desde quando vale');
  await put({ enabled: true, phone: null });
  const again = await prisma.alertSettings.findUniqueOrThrow({ where: { userId: owner.user.id } });
  assert.deepEqual([again.phone, again.enabledAt?.getTime()], [null, since!.getTime()], 'salvar de novo ligado não recomeça a contagem');
  assert.equal((await other.call('GET', '/api/alerts')).json().enabled, false, 'preferência é de cada conta');
  assert.equal((await owner.call('POST', '/api/alerts/test', {})).statusCode, 409, 'sem WhatsApp conectado não há teste');
  await put({ enabled: false, phone: null });
  assert.equal((await prisma.alertSettings.findUniqueOrThrow({ where: { userId: owner.user.id } })).enabledAt, null);

  // Com a conexão do dono: o teste sai na hora, para o destino salvo, e fica no histórico.
  const notices: [string, string | null | undefined][] = [];
  let broken = false;
  const mini = Fastify();
  registerAuth(mini, loadConfig({}));
  registerAlertRoutes(mini, { forOwner: async userId => (userId === owner.user.id
    ? { status: () => ({ state: 'connected' }), notify: async (text, phone) => { if (broken) throw new Error('Timed Out'); notices.push([text, phone]); } }
    : null) });
  const tryIt = (who = owner) => mini.inject({ method: 'POST', url: '/api/alerts/test', headers: as(who.session), payload: {} });
  try {
    await put({ enabled: true, phone: '11 91234-5678' });
    const tested = await tryIt();
    assert.equal(tested.statusCode, 200, tested.body);
    assert.equal(notices.length, 1);
    assert.match(notices[0][0], /^\*DocDrop\* · Aviso de teste\n/);
    assert.equal(notices[0][1], '5511912345678');
    assert.deepEqual(tested.json().recent.map((r: { title: string; sentAt: string | null; error: string | null }) => [r.title, Boolean(r.sentAt), r.error]), [['Aviso de teste', true, null]]);
    assert.equal((await tryIt(other)).statusCode, 409, 'cada conta só usa a própria conexão');
    broken = true;
    const failed = await tryIt();
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().error, 'O WhatsApp não aceitou o aviso.', 'erro técnico não vai para a tela');
    await tryIt();
    assert.equal((await tryIt()).statusCode, 429, '3 testes a cada 10 minutos');
    assert.equal(notices.length, 1);
  } finally { await mini.close(); }
});

test('owner alerts (048): a finished real campaign and an automatic pause become one notice each, sent once through the owner connection', async () => {
  const user = await prisma.user.create({ data: { email: 'avisado@teste.local', name: 'Avisado', passwordHash: 'x' } });
  const quiet = await prisma.user.create({ data: { email: 'sem-aviso@teste.local', name: 'Sem aviso', passwordHash: 'x' } });
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  let seq = 0;
  async function finished(userId: string, name: string, attempts: { status: 'SENT' | 'FAILED'; at: Date }[], provider = 'baileys') {
    const campaign = await prisma.campaign.create({ data: { userId, name, startsAt: new Date(0), endsAt: new Date(0), status: 'COMPLETED', provider } });
    for (const [sequence, attempt] of attempts.entries()) {
      const group = await prisma.group.create({ data: { userId, name: `${name} ${sequence}`, externalId: `aviso-${now.getTime()}-${seq++}@g.us` } });
      await prisma.delivery.create({ data: { campaignId: campaign.id, groupId: group.id, messageBody: 'oi', provider, sequence, status: attempt.status, scheduledAt: attempt.at, attemptedAt: attempt.at } });
    }
    return campaign;
  }
  await prisma.alertSettings.create({ data: { userId: user.id, enabled: true, enabledAt: ago(60) } });
  const done = await finished(user.id, 'Sexta', [{ status: 'SENT', at: ago(9) }, { status: 'SENT', at: ago(7) }, { status: 'FAILED', at: ago(5) }]);
  const recent = await finished(user.id, 'Acabou agora', [{ status: 'SENT', at: ago(0.5) }]);
  await finished(user.id, 'Antes de ligar', [{ status: 'SENT', at: ago(120) }]);
  await finished(user.id, 'Simulada', [{ status: 'SENT', at: ago(5) }], 'simulator');
  await finished(quiet.id, 'De outra conta', [{ status: 'SENT', at: ago(5) }]);
  const origin = 'https://painel.teste';
  const mine = () => prisma.ownerAlert.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'asc' }, { key: 'asc' }] });

  assert.equal(await collectAlerts(origin, now), 1, 'só a campanha real, já assentada, de depois de ligar os avisos');
  assert.equal((await mine())[0].text, `*DocDrop* · Campanha concluída\n"Sexta": 2 de 3 envios feitos. 1 falhou.\n${origin}/campanhas/${done.id}`);
  assert.equal(await collectAlerts(origin, now), 0, 'o mesmo fato não vira dois avisos');
  assert.equal(await prisma.ownerAlert.count({ where: { userId: quiet.id } }), 0, 'conta sem avisos ligados não recebe nada');
  // Dois minutos depois do último envio, a que acabou agora também avisa.
  const later = new Date(now.getTime() + 3 * 60_000);
  assert.equal(await collectAlerts(origin, later), 1);
  assert.ok((await mine())[1].text.endsWith(`"Acabou agora": 1 de 1 envio feito.\n${origin}/campanhas/${recent.id}`));
  // Pausa automática por sinal de restrição (ADR-041). No banco de teste ela vem desligada.
  await prisma.sendingPolicy.create({ data: { userId: user.id, autoPause: true } });
  const pausedAt = new Date(later.getTime() + 1000);
  await safetyPause(user.id, SAFETY_REASONS.rateLimited, pausedAt);
  assert.equal(await collectAlerts(origin, pausedAt), 1);
  assert.match((await mine())[2].text, /^\*DocDrop\* · Campanhas pausadas\nO WhatsApp limitou os envios/);

  const out: string[] = [];
  let state = 'disconnected';
  let broken = false;
  const router = { forOwner: async (userId: string) => (userId === user.id
    ? { status: () => ({ state }), notify: async (text: string) => { if (broken) throw new Error('Timed Out'); out.push(text.split('\n')[0]); } }
    : null) };
  assert.equal(await deliverAlerts(router, pausedAt), 0, 'sem a conexão do dono, o aviso espera');
  state = 'connected';
  const anyGroup = await prisma.group.findFirstOrThrow({ where: { userId: user.id } });
  const busy = await prisma.delivery.create({ data: { campaignId: done.id, groupId: anyGroup.id, messageBody: 'oi', provider: 'baileys', sequence: 99, status: 'PROCESSING', scheduledAt: pausedAt } });
  assert.equal(await deliverAlerts(router, pausedAt), 0, 'com um envio de campanha saindo agora, espera a próxima rodada');
  await prisma.delivery.delete({ where: { id: busy.id } });
  assert.equal(await deliverAlerts(router, pausedAt), 1, 'um aviso por conta a cada rodada');
  assert.equal(await deliverAlerts(router, pausedAt), 1);
  broken = true;
  assert.equal(await deliverAlerts(router, pausedAt), 0);
  broken = false;
  assert.equal(await deliverAlerts(router, pausedAt), 0, 'aviso que falhou não é repetido');
  assert.deepEqual(out, ['*DocDrop* · Campanha concluída', '*DocDrop* · Campanha concluída']);
  assert.deepEqual((await mine()).map(alert => [Boolean(alert.sentAt), alert.error]), [[true, null], [true, null], [false, 'O WhatsApp não aceitou o aviso.']]);

  // Aviso velho (o WhatsApp ficou desconectado) e avisos desligados: abandonados com o motivo.
  const old = await prisma.ownerAlert.create({ data: { userId: user.id, key: 'fim:velho', text: 'velho', createdAt: new Date(pausedAt.getTime() - ALERT_EXPIRY_MS - 60_000) } });
  await deliverAlerts(router, pausedAt);
  assert.match((await prisma.ownerAlert.findUniqueOrThrow({ where: { id: old.id } })).error ?? '', /desconectado/);
  await prisma.alertSettings.update({ where: { userId: user.id }, data: { enabled: false, enabledAt: null } });
  const off = await prisma.ownerAlert.create({ data: { userId: user.id, key: 'fim:desligado', text: 'desligado', createdAt: pausedAt } });
  assert.equal(await deliverAlerts(router, pausedAt), 0);
  assert.match((await prisma.ownerAlert.findUniqueOrThrow({ where: { id: off.id } })).error ?? '', /desligados/);
  assert.equal(out.length, 2);
  // Excluir a conta leva os avisos junto.
  await prisma.campaign.deleteMany({ where: { userId: user.id } });
  await prisma.group.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.ownerAlert.count({ where: { userId: user.id } }) + await prisma.alertSettings.count({ where: { userId: user.id } }), 0);
});

// ─── Proteção do número (ADR-041) ───────────────────────────────────────────────
const spTime = (day: string, clock: string) => new Date(`${day}T${clock}:00-03:00`);
async function protectedQueue(email: string, rules: { quietStart?: number | null; quietEnd?: number | null; dailyLimit?: number | null; groupGapMinutes?: number | null; autoPause?: boolean }) {
  const user = await prisma.user.create({ data: { email, name: email.split('@')[0], passwordHash: 'x' } });
  await prisma.sendingPolicy.create({ data: { userId: user.id, quietStart: null, quietEnd: null, dailyLimit: null, groupGapMinutes: null, autoPause: true, ...rules } });
  const group = await prisma.group.create({ data: { userId: user.id, name: 'Protegido', externalId: `${user.id}@g.us` } });
  const accountJid = `55${Date.now()}${Math.floor(Math.random() * 1000)}@s.whatsapp.net`;
  const campaign = await prisma.campaign.create({ data: { userId: user.id, name: 'Protegida', startsAt: new Date(0), endsAt: new Date(0), status: 'ACTIVE', provider: 'baileys', accountJid, groups: { create: [{ groupId: group.id, position: 0 }] } } });
  const delivery = (sequence: number, data: { scheduledAt: Date; status?: 'PENDING' | 'SENT'; sentAt?: Date; attemptedAt?: Date }) =>
    prisma.delivery.create({ data: { campaignId: campaign.id, groupId: group.id, messageBody: 'oi', provider: 'baileys', sequence, status: data.status ?? 'PENDING', scheduledAt: data.scheduledAt, sentAt: data.sentAt, attemptedAt: data.attemptedAt } });
  return { user, group, campaign, delivery };
}

test('number protection: quiet hours hold the queue without failing and release at the end', async () => {
  const { delivery } = await protectedQueue('silencio@teste.local', { quietStart: 22 * 60, quietEnd: 8 * 60 });
  const night = spTime('2026-10-01', '23:00');
  const row = await delivery(0, { scheduledAt: new Date(night.getTime() - 60_000) });
  const blocks: string[] = [];
  assert.equal(await claimDelivery(prisma, row.id, night, block => blocks.push(`${block.reason}@${block.until.toISOString()}`)), null, 'de noite não sai');
  assert.deepEqual(blocks, [`quiet@${spTime('2026-10-02', '08:00').toISOString()}`]);
  assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { id: row.id } })).status, 'PENDING', 'espera, não falha');
  assert.ok(await claimDelivery(prisma, row.id, spTime('2026-10-02', '08:00')), 'às 08:00 sai');
});

test('number protection: the daily limit counts every attempt of the number that day', async () => {
  const { delivery } = await protectedQueue('limite@teste.local', { dailyLimit: 1 });
  const at = spTime('2026-10-01', '15:00');
  await delivery(0, { scheduledAt: new Date(at.getTime() - 3_600_000), status: 'SENT', attemptedAt: new Date(at.getTime() - 3_600_000), sentAt: new Date(at.getTime() - 3_600_000) });
  const next = await delivery(1, { scheduledAt: new Date(at.getTime() - 60_000) });
  let reason = '';
  assert.equal(await claimDelivery(prisma, next.id, at, block => { reason = block.reason; }), null);
  assert.equal(reason, 'daily');
  assert.ok(await claimDelivery(prisma, next.id, spTime('2026-10-02', '00:01')), 'no dia seguinte volta');
});

test('number protection: the same group waits the group interval', async () => {
  const { delivery } = await protectedQueue('grupo@teste.local', { groupGapMinutes: 120 });
  const at = spTime('2026-10-01', '11:00');
  await delivery(0, { scheduledAt: spTime('2026-10-01', '10:00'), status: 'SENT', attemptedAt: spTime('2026-10-01', '10:00'), sentAt: spTime('2026-10-01', '10:00') });
  const next = await delivery(1, { scheduledAt: new Date(at.getTime() - 60_000) });
  let reason = '';
  assert.equal(await claimDelivery(prisma, next.id, at, block => { reason = block.reason; }), null);
  assert.equal(reason, 'group');
  assert.ok(await claimDelivery(prisma, next.id, spTime('2026-10-01', '12:00')), '2 h depois sai');
});

test('number protection: only the administrator sees or changes the rules, account by account, and saving never touches another account', async () => {
  const admin = await lgpdUser('regras-a@teste.local', 'SUPER_ADMIN');
  const client = await lgpdUser('regras-b@teste.local');
  const other = await lgpdUser('regras-c@teste.local');
  const rules = (id: string) => `/api/admin/users/${id}/sending-policy`;
  const put = (who: typeof admin, id: string, payload: object) => app.inject({ method: 'PUT', url: rules(id), payload, headers: as(who.session) });
  const allOff = { quiet: { enabled: false }, dailyLimit: null, groupGapMinutes: null, autoPause: true };
  // Cliente comum não vê nem muda regra nenhuma, nem as da própria conta (ADR-049/050).
  assert.equal((await client.call('GET', rules(client.user.id))).statusCode, 403);
  assert.equal((await put(client, client.user.id, allOff)).statusCode, 403);
  assert.equal((await admin.call('GET', '/api/sending-policy')).statusCode, 404, 'a rota antiga, da própria conta, saiu');
  assert.equal((await admin.call('GET', rules('nao-existe'))).statusCode, 404);

  const initial = (await admin.call('GET', rules(client.user.id))).json();
  assert.deepEqual(initial.defaults, { quiet: { enabled: true, start: '22:00', end: '08:00' }, dailyLimit: 150, groupGapMinutes: 120, autoPause: true });
  const body = { quiet: { enabled: true, start: '23:00', end: '07:30' }, dailyLimit: 200, groupGapMinutes: 180, autoPause: false };
  for (const bad of [{ ...body, dailyLimit: 5 }, { ...body, groupGapMinutes: 10 }, { ...body, quiet: { enabled: true, start: '25:00', end: '07:00' } }, { ...body, quiet: { enabled: true, start: '08:00', end: '08:00' } }]) {
    assert.equal((await put(admin, client.user.id, bad)).statusCode, 400, JSON.stringify(bad));
  }
  const saved = await put(admin, client.user.id, body);
  assert.equal(saved.statusCode, 200, saved.body);
  const stored = await prisma.sendingPolicy.findUniqueOrThrow({ where: { userId: client.user.id } });
  assert.deepEqual([stored.quietStart, stored.quietEnd, stored.dailyLimit, stored.groupGapMinutes, stored.autoPause], [23 * 60, 7 * 60 + 30, 200, 180, false]);
  assert.deepEqual((await admin.call('GET', rules(client.user.id))).json().quiet, body.quiet);
  assert.equal((await put(admin, client.user.id, allOff)).statusCode, 200, 'cada regra pode ser desligada');
  assert.equal(await prisma.sendingPolicy.count({ where: { userId: { in: [other.user.id, admin.user.id] } } }), 0, 'só a conta escolhida muda');
  // O administrador ajusta as regras da própria conta pelo mesmo caminho.
  assert.equal((await put(admin, admin.user.id, body)).statusCode, 200);
  assert.equal((await prisma.sendingPolicy.findUniqueOrThrow({ where: { userId: admin.user.id } })).dailyLimit, 200);
});

test('dashboard: each running campaign shows the real state of its next send (quiet hours, offline), not "sending"', async () => {
  await pauseEverything();
  const owner = await lgpdUser('inicio-real@teste.local');
  const groups = [];
  for (let i = 0; i < 3; i++) groups.push(await prisma.group.create({ data: { userId: owner.user.id, name: `Início ${i}`, externalId: `inicio-${Date.now()}-${i}@g.us` } }));
  const past = new Date(Date.now() - 600_000);
  const campaign = await prisma.campaign.create({ data: { userId: owner.user.id, name: 'No ar', startsAt: past, endsAt: past, status: 'ACTIVE', provider: 'baileys', accountJid: `55${Date.now()}@s.whatsapp.net`, mode: 'IMMEDIATE', nextAvailableAt: past } });
  await prisma.delivery.create({ data: { campaignId: campaign.id, groupId: groups[0].id, messageBody: 'oi', provider: 'baileys', sequence: 0, status: 'SENT', scheduledAt: past, attemptedAt: past, sentAt: past, deliveredAt: past } });
  await prisma.delivery.create({ data: { campaignId: campaign.id, groupId: groups[1].id, messageBody: 'oi', provider: 'baileys', sequence: 1, status: 'FAILED', scheduledAt: past, attemptedAt: past, error: 'x' } });
  await prisma.delivery.create({ data: { campaignId: campaign.id, groupId: groups[2].id, messageBody: 'oi', provider: 'baileys', sequence: 2, status: 'PENDING', scheduledAt: past } });
  const running = async () => (await owner.call('GET', '/api/dashboard')).json().runningCampaigns.find((c: { id: string }) => c.id === campaign.id);

  // Sem regra nenhuma e com o WhatsApp da conta fora do ar: o envio espera a conexão.
  let row = await running();
  assert.deepEqual([row.sent, row.failed, row.pending, row.delivered, row.total], [1, 1, 1, 1, 3]);
  assert.deepEqual([row.next.group, row.next.kind], ['Início 2', 'offline']);

  // Horário de silêncio cobrindo agora: o Início diz "em silêncio" e quando sai, nunca "saindo agora".
  const minute = localMinute(new Date());
  const quietEnd = (minute + 120) % 1440;
  await prisma.sendingPolicy.create({ data: { userId: owner.user.id, quietStart: (minute + 1380) % 1440, quietEnd, autoPause: true } });
  const connected = Fastify();
  registerAuth(connected, loadConfig({}));
  registerCampaignRoutes(connected, async () => true);
  try {
    row = (await connected.inject({ method: 'GET', url: '/api/dashboard', headers: as(owner.session) })).json().runningCampaigns.find((c: { id: string }) => c.id === campaign.id);
    assert.equal(row.next.kind, 'quiet');
    assert.match(row.next.reason, /^Horário de silêncio · sai /);
    assert.equal(localMinute(new Date(row.next.expectedAt)), quietEnd, 'a previsão é o fim do silêncio');
    // Bloco Hoje: os envios do número no dia e a janela de silêncio, só para leitura.
    const usage = (await connected.inject({ method: 'GET', url: '/api/dashboard', headers: as(owner.session) })).json().usage;
    assert.deepEqual([usage.used, usage.limit, usage.warmup, usage.quiet.active], [0, null, null, true]);
    assert.equal(localMinute(new Date(usage.quiet.until)), quietEnd);
    // Fora do silêncio e conectado: aí sim está saindo.
    await prisma.sendingPolicy.update({ where: { userId: owner.user.id }, data: { quietStart: null, quietEnd: null } });
    row = (await connected.inject({ method: 'GET', url: '/api/dashboard', headers: as(owner.session) })).json().runningCampaigns.find((c: { id: string }) => c.id === campaign.id);
    assert.equal(row.next.kind, 'now');
  } finally { await connected.close(); }
  await pauseEverything();
});

// ─── Planos por cliente (ADR-050) ───────────────────────────────────────────────
test('plans (050): the administrator sets plan, due date, pause and groups per campaign; an expired or paused account keeps its data but cannot send', async () => {
  await pauseEverything();
  const admin = await lgpdUser('plano-admin@teste.local', 'SUPER_ADMIN');
  const client = await lgpdUser('plano-cliente@teste.local');
  const planUrl = `/api/admin/users/${client.user.id}/plan`;
  const put = (payload: object, who = admin, url = planUrl) => app.inject({ method: 'PUT', url, payload, headers: as(who.session) });
  const base = { plan: 'Mensal', priceCents: 14700, dueDate: null as string | null, paused: false, maxGroups: null as number | null };
  const day = (offset: number) => new Date(Date.parse(`${todayOf(new Date())}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const mine = async () => (await client.call('GET', '/api/plan')).json();

  // Sem plano definido, nada vence e nada limita.
  assert.deepEqual(await mine(), { plan: null, dueDate: null, daysLeft: null, state: 'active', maxGroups: null, message: null, dueSoonDays: 5 });
  // Só o administrador define; o cliente nem lê pela rota do administrador.
  assert.equal((await put(base, client)).statusCode, 403);
  assert.equal((await client.call('GET', planUrl)).statusCode, 403);
  for (const bad of [{ ...base, maxGroups: 0 }, { ...base, maxGroups: 501 }, { ...base, dueDate: '2026-13-40' }, { ...base, priceCents: -1 }, { ...base, plan: 'x'.repeat(41) }, { ...base, paused: 'sim' }]) {
    assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await put(base, admin, `/api/admin/users/${admin.user.id}/plan`)).statusCode, 400, 'administrador não tem plano');
  assert.equal((await put(base, admin, '/api/admin/users/nao-existe/plan')).statusCode, 404);

  // Grupos por campanha.
  const groups = [];
  for (let i = 0; i < 3; i++) groups.push(await prisma.group.create({ data: { name: `Plano ${i}`, userId: client.user.id, externalId: `plano-${Date.now()}-${i}@g.us` } }));
  assert.equal((await put({ ...base, maxGroups: 2, dueDate: day(10) })).statusCode, 200);
  const campaign = (groupIds: string[]) => client.call('POST', '/api/campaigns', { name: 'Do plano', mode: 'IMMEDIATE', messages: ['oi'], groupIds });
  const tooMany = await campaign(groups.map(g => g.id));
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.json().error, /até 2 grupos por campanha \(esta tem 3\)/);
  const created = await campaign(groups.slice(0, 2).map(g => g.id));
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const status = (next: string) => app.inject({ method: 'PATCH', url: `/api/campaigns/${id}/status`, payload: { status: next, provider: 'simulator' }, headers: as(client.session) });
  const stateOf = async () => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;

  // O cliente vê o próprio plano, sem o valor combinado.
  assert.deepEqual(await mine(), { plan: 'Mensal', dueDate: day(10), daysLeft: 10, state: 'active', maxGroups: 2, message: null, dueSoonDays: 5 });
  assert.equal((await status('ACTIVE')).statusCode, 200);

  // Vencida: salvar já pausa as campanhas, e a conta não retoma até renovar.
  const expired = await put({ ...base, maxGroups: 2, dueDate: day(-1) });
  assert.deepEqual([expired.json().state, expired.json().pausedCampaigns], ['expired', 1]);
  assert.equal(await stateOf(), 'PAUSED');
  const refused = await status('ACTIVE');
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /assinatura venceu em \d\d\/\d\d/);
  assert.equal((await mine()).state, 'expired');
  assert.equal((await client.call('GET', '/api/campaigns')).statusCode, 200, 'a conta continua entrando e vendo tudo');
  assert.equal((await client.call('POST', `/api/campaigns/${id}/retry-failed`, {})).statusCode, 400, 'tentar de novo também é envio');

  // Renovada até hoje: vence só depois do dia de hoje.
  assert.equal((await put({ ...base, maxGroups: 2, dueDate: day(0) })).json().state, 'active');
  assert.equal((await mine()).daysLeft, 0);
  assert.equal((await status('ACTIVE')).statusCode, 200);

  // Plano com menos grupos do que a campanha já tem: ela não é retomada.
  await status('PAUSED');
  await put({ ...base, maxGroups: 1, dueDate: day(0) });
  assert.match((await status('ACTIVE')).json().error, /até 1 grupo por campanha/);
  await put({ ...base, dueDate: day(0) });
  assert.equal((await status('ACTIVE')).statusCode, 200);

  // Conta pausada pelo administrador (mês sem uso): mesma trava, com outra mensagem.
  const paused = await put({ ...base, dueDate: day(30), paused: true });
  assert.deepEqual([paused.json().state, paused.json().paused, paused.json().pausedCampaigns], ['paused', true, 1]);
  assert.equal(await stateOf(), 'PAUSED');
  assert.match((await status('ACTIVE')).json().error, /conta está pausada/);
  assert.equal((await put({ ...base, dueDate: day(30) })).json().state, 'active');
  assert.equal((await status('ACTIVE')).statusCode, 200);

  // A conferência de cada minuto pega o vencimento que chega sozinho (virada do dia).
  await prisma.subscription.update({ where: { userId: client.user.id }, data: { dueDate: new Date(`${day(-1)}T00:00:00.000Z`) } });
  assert.equal(await stateOf(), 'ACTIVE');
  assert.ok(await pauseBlockedAccounts(new Date()) >= 1);
  assert.equal(await stateOf(), 'PAUSED');

  // A lista de contas mostra o plano; administrador não tem plano nem é bloqueado.
  const list = (await admin.call('GET', '/api/admin/users')).json() as { id: string; plan: { plan: string; priceCents: number; state: string } | null }[];
  const row = list.find(u => u.id === client.user.id)!;
  assert.deepEqual([row.plan?.plan, row.plan?.priceCents, row.plan?.state], ['Mensal', 14700, 'expired']);
  assert.equal(list.find(u => u.id === admin.user.id)!.plan, null);
  await prisma.subscription.create({ data: { userId: admin.user.id, pausedAt: new Date() } });
  assert.equal((await planOf(admin.user.id, new Date())).blocked, null);
  await pauseEverything();
});

test('number protection: a restriction signal pauses every active campaign of that account only, until resumed by hand', async () => {
  const { user, campaign, delivery } = await protectedQueue('restricao@teste.local', {});
  const other = await protectedQueue('restricao-outra@teste.local', {});
  const now = new Date();
  for (let i = 0; i < REJECTIONS_TO_PAUSE; i++) {
    const row = await delivery(i, { scheduledAt: new Date(now.getTime() - 600_000 - i * 1000), status: 'SENT', sentAt: new Date(now.getTime() - 600_000) });
    await prisma.delivery.update({ where: { id: row.id }, data: { serverRejectedAt: new Date(now.getTime() - 60_000) } });
  }
  assert.ok(await checkRejections(now) >= 1);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'PAUSED');
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: other.campaign.id } })).status, 'ACTIVE', 'outra conta segue');
  const session = await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } });
  assert.match(session.safetyReason ?? '', /recusou 3 mensagens/);
  // A pessoa retoma: as mesmas recusas não pausam de novo.
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'ACTIVE', pausedAt: null } });
  await checkRejections(new Date(now.getTime() + 1000));
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE');
  // Com a pausa automática desligada, o sinal não pausa.
  await prisma.sendingPolicy.update({ where: { userId: other.user.id }, data: { autoPause: false } });
  assert.equal(await safetyPause(other.user.id, SAFETY_REASONS.forbidden), 0);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: other.campaign.id } })).status, 'ACTIVE');
});

async function rejectedProtectionQueue(email: string) {
  const world = await protectedQueue(email, {});
  // Os recibos fictícios já chegaram antes da varredura. A referência HTTPS dos testes
  // tem precisão de segundos; não cria um recibo ligeiramente "futuro" por arredondamento.
  const now = new Date(Date.now() - 2000);
  const rows: Awaited<ReturnType<typeof world.delivery>>[] = [];
  for (let i = 0; i < REJECTIONS_TO_PAUSE; i++) {
    const row = await world.delivery(i, { scheduledAt: new Date(now.getTime() - 600_000 - i * 1000), status: 'SENT', sentAt: new Date(now.getTime() - 600_000) });
    rows.push(await prisma.delivery.update({ where: { id: row.id }, data: { providerId: `${world.user.id}-${i}`, serverRejectedAt: new Date(now.getTime() - 60_000) } }));
  }
  const pending = await world.delivery(3, { scheduledAt: new Date(now.getTime() - 1000) });
  const event = (i: number) => ({ kind: 'delivered' as const, messageId: rows[i].providerId!, groupJid: world.group.externalId!, accountJid: world.campaign.accountJid!, ownerId: world.user.id, at: now });
  const pause = async () => {
    await checkRejections(now);
    await prisma.whatsAppSession.update({ where: { userId: world.user.id }, data: { accountJid: world.campaign.accountJid } });
  };
  const connected = (id: string) => id === world.user.id ? world.campaign.accountJid : null;
  return { ...world, rows, pending, now, event, pause, connected };
}

test('number protection: confirmed deliveries and reads are not refusals for the safety threshold', async () => {
  const world = await rejectedProtectionQueue('falso-alarme-confirmado@teste.local');
  await applyServerEvent(prisma, world.event(0));
  await applyServerEvent(prisma, world.event(1));
  await prisma.deliveryRead.create({ data: { deliveryId: world.rows[2].id, recipientHash: 'leitura-confirmada-teste', readAt: world.now } });
  await checkRejections(world.now);
  assert.equal(await safetyPause(world.user.id, SAFETY_REASONS.rejections(3), world.now, true), 0, 'revalidação antes de pausar também descarta o falso alarme');
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: world.campaign.id } })).status, 'ACTIVE');
  assert.equal(await prisma.whatsAppSession.findUnique({ where: { userId: world.user.id } }), null);
});

test('number protection: false alarm recovery preserves pending work and interval, is idempotent and survives a database reconnect', async () => {
  const world = await rejectedProtectionQueue('falso-alarme-retoma@teste.local');
  await prisma.campaign.update({ where: { id: world.campaign.id }, data: { nextAvailableAt: new Date(world.now.getTime() + 120_000) } });
  await world.pause();
  assert.equal(await recoverConfirmedRejections(world.connected, new Date(world.now.getTime() + 86_400_000)), 0, 'passar um dia não resolve a recusa');
  await prisma.alertSettings.create({ data: { userId: world.user.id, enabled: true, enabledAt: new Date(world.now.getTime() - 1000) } });
  await collectAlerts('http://localhost', world.now);
  const alertKey = `pausa:${world.user.id}:${world.now.getTime()}`;
  assert.equal(await prisma.ownerAlert.count({ where: { userId: world.user.id, key: alertKey, sentAt: null, error: null } }), 1);
  for (let i = 0; i < world.rows.length; i++) await applyServerEvent(prisma, world.event(i));
  assert.equal(await recoverConfirmedRejections(() => null, world.now), 0, 'desconectado não retoma');
  assert.equal(await recoverConfirmedRejections(() => 'outro-numero@s.whatsapp.net', world.now), 0, 'outro número não retoma');
  await prisma.$disconnect();
  const later = new Date(world.now.getTime() + 300_000);
  assert.equal(await recoverConfirmedRejections(world.connected, later), 1);
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: world.campaign.id } });
  assert.deepEqual([campaign.status, campaign.pausedAt, campaign.nextAvailableAt?.getTime()], ['ACTIVE', null, later.getTime() + 120_000]);
  assert.equal((await fresh(world.pending.id)).status, 'PENDING');
  for (const row of world.rows) {
    const saved = await fresh(row.id);
    assert.deepEqual([saved.status, saved.providerId, saved.attempts], ['SENT', row.providerId, row.attempts], 'não recria nem reenvia o que chegou');
  }
  assert.equal(await recoverConfirmedRejections(world.connected, later), 0, 'repetir não retoma novamente');
  assert.equal((await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: world.user.id } })).safetyReason, null);
  assert.match((await prisma.ownerAlert.findFirstOrThrow({ where: { userId: world.user.id, key: alertKey } })).error ?? '', /falso alarme resolvido/);
  await collectAlerts('http://localhost', later);
  assert.equal(await prisma.ownerAlert.count({ where: { userId: world.user.id, key: alertKey, error: null } }), 0, 'não recria aviso da pausa já resolvida');
});

test('number protection: false alarm recovery never overrides manual changes, cancellation or disabled accounts', async () => {
  for (const mode of ['manual', 'cancelled', 'disabled'] as const) {
    const world = await rejectedProtectionQueue(`falso-alarme-${mode}@teste.local`);
    await world.pause();
    for (let i = 0; i < world.rows.length; i++) await applyServerEvent(prisma, world.event(i));
    if (mode === 'manual') await prisma.campaign.update({ where: { id: world.campaign.id }, data: { pausedAt: new Date(world.now.getTime() + 1000), updatedAt: new Date(world.now.getTime() + 1000) } });
    if (mode === 'cancelled') await prisma.campaign.update({ where: { id: world.campaign.id }, data: { status: 'CANCELLED' } });
    if (mode === 'disabled') await prisma.user.update({ where: { id: world.user.id }, data: { disabledAt: world.now } });
    assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, mode);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: world.campaign.id } })).status, mode === 'cancelled' ? 'CANCELLED' : 'PAUSED');
  }
});

test('number protection: restriction notices, incomplete proof and uncertain outcomes never resume automatically', async () => {
  const world = await rejectedProtectionQueue('falso-alarme-restricao@teste.local');
  await world.pause();
  for (let i = 0; i < world.rows.length - 1; i++) await applyServerEvent(prisma, world.event(i));
  assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, 'uma recusa ainda não foi resolvida');
  await applyServerEvent(prisma, world.event(2));
  await prisma.delivery.update({ where: { id: world.rows[2].id }, data: { status: 'FAILED' } });
  assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, 'resultado ainda marcado como falha não é retomado');
  await prisma.delivery.update({ where: { id: world.rows[2].id }, data: { status: 'SENT' } });
  for (const reason of [SAFETY_REASONS.forbidden, SAFETY_REASONS.rateLimited]) {
    await prisma.whatsAppSession.update({ where: { userId: world.user.id }, data: { safetyReason: reason } });
    assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, reason);
    await safetyPause(world.user.id, SAFETY_REASONS.rejections(3), world.now, true);
    assert.equal((await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: world.user.id } })).safetyReason, reason, 'não substitui aviso de restrição por recusa genérica');
  }
});

test('number protection: false alarm recovery respects a paused subscription and the campaign group limit', async () => {
  const world = await rejectedProtectionQueue('falso-alarme-plano@teste.local');
  await world.pause();
  for (let i = 0; i < world.rows.length; i++) await applyServerEvent(prisma, world.event(i));
  await prisma.subscription.create({ data: { userId: world.user.id, pausedAt: world.now } });
  assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0);
  await prisma.subscription.update({ where: { userId: world.user.id }, data: { pausedAt: null, maxGroups: 1 } });
  const group = await prisma.group.create({ data: { userId: world.user.id, name: 'Outro', externalId: `${world.user.id}-outro@g.us` } });
  await prisma.campaignGroup.create({ data: { campaignId: world.campaign.id, groupId: group.id, userId: world.user.id, position: 1 } });
  assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, 'não contorna limite do plano');
});

test('number protection: a concurrent explicit restriction always wins over false alarm recovery', async () => {
  const world = await rejectedProtectionQueue('falso-alarme-concorrente@teste.local');
  await world.pause();
  for (let i = 0; i < world.rows.length; i++) await applyServerEvent(prisma, world.event(i));
  await Promise.all([
    recoverConfirmedRejections(world.connected, world.now),
    safetyPause(world.user.id, SAFETY_REASONS.forbidden, world.now),
  ]);
  assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: world.campaign.id } })).status, 'PAUSED');
  assert.equal((await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: world.user.id } })).safetyReason, SAFETY_REASONS.forbidden);
});

test('number protection: a new refusal and explicit restriction codes prevent false alarm recovery', async () => {
  const world = await rejectedProtectionQueue('falso-alarme-nova-recusa@teste.local');
  await world.pause();
  for (let i = 0; i < world.rows.length; i++) await applyServerEvent(prisma, world.event(i));
  for (const code of ['servidor:403', 'servidor:429']) {
    await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { errorCode: code } });
    assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, code);
  }
  await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { errorCode: 'servidor:500' } });
  await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { serverRejectedAt: new Date(world.now.getTime() + 1000) } });
  assert.equal(await recoverConfirmedRejections(world.connected, new Date(world.now.getTime() + 2000)), 0, 'uma recusa posterior confirmada não substitui a prova de um sinal original perdido');
  await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { serverRejectedAt: new Date(world.now.getTime() - 60_000), deliveredAt: new Date(world.now.getTime() - 1000) } });
  assert.equal(await recoverConfirmedRejections(world.connected, world.now), 0, 'recibo anterior à pausa não prova resolução de um sinal original sem identificação');
  await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { deliveredAt: world.now } });
  await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { sentAt: new Date(world.now.getTime() + 1000) } });
  assert.equal(await recoverConfirmedRejections(world.connected, new Date(world.now.getTime() + 2000)), 0, 'uma nova tentativa após a pausa deixa a origem dos sinais incerta');
  await prisma.delivery.update({ where: { id: world.rows[0].id }, data: { sentAt: new Date(world.now.getTime() - 600_000) } });
  await prisma.delivery.update({ where: { id: world.pending.id }, data: { serverRejectedAt: new Date(world.now.getTime() + 1000) } });
  assert.equal(await recoverConfirmedRejections(world.connected, new Date(world.now.getTime() + 2000)), 0, 'uma recusa nova não desaparece por causa de recibos antigos');
});

test('number protection: the dispatcher applies confirmations before checking refusals and sends only the remaining delivery', async () => {
  await pauseEverything();
  const world = await rejectedProtectionQueue('falso-alarme-despachante@teste.local');
  await world.pause();
  let calls = 0;
  const provider = {
    status: () => ({ state: 'connected', accountJid: world.campaign.accountJid! }),
    send: async () => { calls++; return { messageId: 'somente-o-pendente', context: 'conector de teste' }; },
    flushReads: async () => undefined,
    flushDeliveryEvents: async () => { for (let i = 0; i < world.rows.length; i++) await applyServerEvent(prisma, world.event(i)); },
  } as SendingProvider;
  const dispatcher = await startDispatcher(staticRouter([{ ownerId: world.user.id, provider }]), { scanIntervalMs: 50 });
  try { await waitFor(async () => (await fresh(world.pending.id)).status === 'SENT', 'retomada do único pendente'); }
  finally { await dispatcher.stop(); }
  assert.equal(calls, 1);
  assert.equal(await prisma.delivery.count({ where: { campaignId: world.campaign.id } }), 4, 'sem reconstruir a fila');
  for (const row of world.rows) assert.equal((await fresh(row.id)).providerId, row.providerId);
});

test('number protection: the pause notice shows in the WhatsApp status until dismissed', async () => {
  const { user, session } = await lgpdUser('aviso@teste.local');
  await prisma.whatsAppSession.create({ data: { userId: user.id, safetyPausedAt: new Date(), safetyReason: SAFETY_REASONS.rateLimited } });
  const status = await app.inject({ method: 'GET', url: '/api/whatsapp/status', headers: as(session) });
  assert.equal(status.json().safety?.reason, SAFETY_REASONS.rateLimited);
  assert.equal((await app.inject({ method: 'POST', url: '/api/whatsapp/safety/dismiss', payload: {}, headers: as(session) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/whatsapp/status', headers: as(session) })).json().safety, undefined);
});

// ─── Aquecimento de número novo (ADR-043) ───────────────────────────────────────
test('warmup: asked once per number; reconnecting the same number does not ask again, another number does', async () => {
  const world = whatsappApp();
  try {
    const { user, call } = await sessionFor(world.app, 'aquece@teste.local');
    world.manager.for(user.id);
    const [first, second] = ['5511900000001@s.whatsapp.net', '5511900000002@s.whatsapp.net'];
    assert.equal((await call('POST', 'warmup', { isNew: true })).statusCode, 409, 'sem WhatsApp conectado não há o que responder');
    world.perUser.get(user.id)!.state = { state: 'connected', accountJid: first };
    assert.deepEqual((await call('GET', 'status')).json().warmup, { needsAnswer: true }, 'número novo no sistema: pergunta');

    const answered = await call('POST', 'warmup', { isNew: true });
    assert.equal(answered.statusCode, 200, answered.body);
    assert.equal(answered.json().day, 1);
    assert.equal(answered.json().limitToday, 30);
    const startedAt = (await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } })).warmupStartedAt;
    assert.ok(startedAt);
    // Caiu e voltou com o MESMO número: não pergunta de novo, o aquecimento continua.
    world.perUser.get(user.id)!.state = { state: 'reconnecting', accountJid: first };
    world.perUser.get(user.id)!.state = { state: 'connected', accountJid: first };
    assert.equal((await call('GET', 'status')).json().warmup.needsAnswer, false);
    await call('POST', 'warmup', { isNew: true });
    assert.equal((await prisma.whatsAppSession.findUniqueOrThrow({ where: { userId: user.id } })).warmupStartedAt?.getTime(), startedAt!.getTime(), '"sim" de novo não reinicia');

    // Outro chip: pergunta de novo e não herda o aquecimento do anterior.
    world.perUser.get(user.id)!.state = { state: 'connected', accountJid: second };
    assert.deepEqual((await call('GET', 'status')).json().warmup, { needsAnswer: true });
    assert.equal((await rulesFor(prisma, user.id, second)).warmupStartedAt, null);
    const notNew = await call('POST', 'warmup', { isNew: false });
    assert.equal(notNew.json().isNew, false);
    assert.equal(notNew.json().limitToday, null);
  } finally { await world.cleanup(); }
});

test('warmup: the queue holds the number at the warmup limit of the day', async () => {
  const { user, campaign, delivery } = await protectedQueue('aquece-fila@teste.local', {});
  const at = spTime('2026-10-02', '15:00');
  await prisma.whatsAppSession.create({ data: { userId: user.id, warmupJid: campaign.accountJid, warmupStartedAt: spTime('2026-10-02', '09:00') } });
  for (let i = 0; i < 30; i++) {
    const sentAt = new Date(at.getTime() - (60 - i) * 60_000);
    await delivery(i, { scheduledAt: sentAt, status: 'SENT', attemptedAt: sentAt, sentAt });
  }
  const next = await delivery(30, { scheduledAt: new Date(at.getTime() - 60_000) });
  let reason = '';
  assert.equal(await claimDelivery(prisma, next.id, at, block => { reason = block.reason; }), null, 'dia 1: 30 envios e para');
  assert.equal(reason, 'daily');
  await prisma.whatsAppSession.update({ where: { userId: user.id }, data: { warmupStartedAt: null } });
  assert.ok(await claimDelivery(prisma, next.id, at), 'sem aquecimento (e sem limite diário nesta conta), sai');
});

// Revisão 2026-10-02: concorrência real em MySQL, sem WhatsApp nem dados de produção.
for (const byAdmin of [false, true]) test(`review: ${byAdmin ? 'admin' : 'own'} password change revokes outstanding reset links`, async () => {
  const owner = await lgpdUser(`review-password-${byAdmin}@teste.local`);
  const admin = await lgpdUser(`review-password-admin-${byAdmin}@teste.local`, 'SUPER_ADMIN');
  const link = await admin.call('POST', `/api/admin/users/${owner.user.id}/reset-link`, {});
  assert.equal(link.statusCode, 200, link.body);
  const token = String(link.json().url).split('/redefinir-senha/')[1];
  const changed = byAdmin
    ? await admin.call('POST', `/api/admin/users/${owner.user.id}/password`, { password: 'review-nova-senha-123' })
    : await owner.call('POST', '/api/auth/password', { current: 'senha-de-teste-123', next: 'review-nova-senha-123' });
  assert.equal(changed.statusCode, 200, changed.body);
  const stale = await app.inject({ method: 'POST', url: `/api/auth/reset/${token}`, headers: anon, payload: { password: 'review-link-antigo-123' } });
  assert.equal(stale.statusCode, 404, 'link anterior não pode substituir a senha nova');
  assert.equal(await prisma.passwordReset.count({ where: { userId: owner.user.id } }), 0);
  assert.equal((await loginAs(app, owner.user.email, 'review-nova-senha-123')).status, 200);
});

test('review: reset expiry is rechecked after the slow hash and account lock', async () => {
  const owner = await lgpdUser('review-expiry@teste.local');
  const admin = await lgpdUser('review-expiry-admin@teste.local', 'SUPER_ADMIN');
  const link = await admin.call('POST', `/api/admin/users/${owner.user.id}/reset-link`, {});
  const token = String(link.json().url).split('/redefinir-senha/')[1];
  let observed!: () => void;
  const found = new Promise<void>(resolve => { observed = resolve; });
  const original = prisma.passwordReset.findFirst;
  // A leitura inicial ainda encontra o link válido. Ele vence antes da transação que o consome.
  prisma.passwordReset.findFirst = (async (...args: Parameters<typeof original>) => {
    const result = await original.apply(prisma.passwordReset, args);
    await prisma.passwordReset.updateMany({ where: { userId: owner.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    observed();
    return result;
  }) as typeof original;
  try {
    const response = app.inject({ method: 'POST', url: `/api/auth/reset/${token}`, headers: anon, payload: { password: 'review-vencido-123' } });
    await found;
    assert.equal((await response).statusCode, 404);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).passwordHash, owner.user.passwordHash);
    assert.equal((await owner.call('GET', '/api/auth/me')).statusCode, 200);
  } finally { prisma.passwordReset.findFirst = original; }
});

test('review: concurrent forgot requests and link issuance leave one pending request or valid link', async () => {
  const owner = await lgpdUser('review-forgot@teste.local');
  const admin = await lgpdUser('review-forgot-admin@teste.local', 'SUPER_ADMIN');
  const responses = await Promise.all(Array.from({ length: 3 }, (_, i) => fromIp(`198.51.100.${110 + i}`, owner.user.email)));
  assert.ok(responses.every(r => r.statusCode === 200));
  assert.equal(await prisma.passwordReset.count({ where: { userId: owner.user.id, tokenHash: null } }), 1);
  const links = await Promise.all(Array.from({ length: 3 }, () => admin.call('POST', `/api/admin/users/${owner.user.id}/reset-link`, {})));
  assert.ok(links.every(r => r.statusCode === 200), links.map(r => r.body).join('\n'));
  assert.equal(await prisma.passwordReset.count({ where: { userId: owner.user.id } }), 1);
  const checks = await Promise.all(links.map(r => app.inject({ method: 'GET', url: `/api/auth/reset/${String(r.json().url).split('/redefinir-senha/')[1]}`, headers: anon })));
  assert.equal(checks.filter(r => r.statusCode === 200).length, 1);
});

test('review: parallel feedback requests cannot exceed the account quota', async () => {
  const owner = await lgpdUser('review-feedback@teste.local');
  await prisma.feedback.createMany({ data: Array.from({ length: 4 }, () => ({ userId: owner.user.id, kind: 'sugestao', message: 'Mensagem de teste isolado' })) });
  const responses = await Promise.all(Array.from({ length: 3 }, () => owner.call('POST', '/api/feedback', { kind: 'sugestao', message: 'Uma sugestão de teste' })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 429, 429]);
  assert.equal(await prisma.feedback.count({ where: { userId: owner.user.id } }), 5);
});

test('review: parallel group list creation and templates from different sources respect the account quotas', async () => {
  const owner = await lgpdUser('review-quotas@teste.local');
  const sources = await Promise.all(['Primeira', 'Segunda'].map(name => lgpdCampaign(owner.user.id, name)));
  const group = await prisma.group.findFirstOrThrow({ where: { userId: owner.user.id } });
  await prisma.groupList.createMany({ data: Array.from({ length: 49 }, (_, i) => ({ userId: owner.user.id, name: `Lista ${i}` })) });
  const lists = await Promise.all(['Última A', 'Última B'].map(name => owner.call('POST', '/api/group-lists', { name, groupIds: [group.id] })));
  assert.deepEqual(lists.map(r => r.statusCode).sort(), [201, 400]);
  assert.equal(await prisma.groupList.count({ where: { userId: owner.user.id } }), 50);
  await prisma.campaign.createMany({ data: Array.from({ length: 49 }, (_, i) => ({ userId: owner.user.id, name: `Modelo ${i}`, isTemplate: true, startsAt: new Date(), endsAt: new Date() })) });
  const templates = await Promise.all(sources.map(s => owner.call('POST', `/api/campaigns/${s.id}/duplicate`, { asTemplate: true })));
  assert.deepEqual(templates.map(r => r.statusCode).sort(), [201, 400]);
  assert.equal(await prisma.campaign.count({ where: { userId: owner.user.id, isTemplate: true } }), 50);
});

test('review: parallel report sharing returns the same link, which revocation disables', async () => {
  const owner = await lgpdUser('review-share@teste.local');
  const campaign = await lgpdCampaign(owner.user.id, 'Relatório concorrente');
  const url = `/api/campaigns/${campaign.id}/report/share`;
  const responses = await Promise.all(Array.from({ length: 4 }, () => owner.call('POST', url, {})));
  assert.ok(responses.every(r => r.statusCode === 200));
  const tokens = new Set(responses.map(r => r.json().shareToken));
  assert.equal(tokens.size, 1);
  const token = responses[0].json().shareToken;
  assert.equal((await app.inject({ method: 'GET', url: `/api/public/report/${token}`, headers: anon })).statusCode, 200);
  assert.equal((await owner.call('DELETE', url)).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/public/report/${token}`, headers: anon })).statusCode, 404);
});

for (const action of ['activate', 'retry', 'retry-failed']) test(`review: ${action} rechecks the plan after waiting for an account update`, async () => {
  const owner = await lgpdUser(`review-plan-${action}@teste.local`);
  const campaign = await lgpdCampaign(owner.user.id, `Plano ${action}`, { status: action === 'activate' ? 'DRAFT' : 'COMPLETED' });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { mode: 'IMMEDIATE' } });
  const group = await prisma.group.findFirstOrThrow({ where: { userId: owner.user.id } });
  const delivery = action === 'activate' ? null : await prisma.delivery.create({ data: { campaignId: campaign.id, groupId: group.id, scheduledAt: new Date(), messageBody: 'teste', status: 'FAILED', error: 'Falha segura', provider: 'simulator', sequence: 0 } });
  let locked!: () => void;
  let release!: () => void;
  const held = new Promise<void>(resolve => { locked = resolve; });
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const update = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${owner.user.id} FOR UPDATE`;
    locked();
    await unblock;
    await tx.subscription.create({ data: { userId: owner.user.id, pausedAt: new Date() } });
  }, { ...LOCKING_TRANSACTION, timeout: 15_000 });
  await held;
  const response = action === 'activate'
    ? app.inject({ method: 'PATCH', url: `/api/campaigns/${campaign.id}/status`, headers: as(owner.session), payload: { status: 'ACTIVE', provider: 'simulator' } })
    : owner.call('POST', action === 'retry' ? `/api/deliveries/${delivery!.id}/retry` : `/api/campaigns/${campaign.id}/retry-failed`, {});
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await update;
    const result = await response;
    assert.equal(result.statusCode, 400, result.body);
    assert.match(result.json().error, /conta está pausada/);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, action === 'activate' ? 'DRAFT' : 'COMPLETED');
    if (delivery) assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status, 'FAILED');
    else assert.equal(await prisma.delivery.count({ where: { campaignId: campaign.id } }), 0);
  } finally { release(); await update; }
});

test('review: a stale sweep candidate cannot pause an account renewed before its lock is acquired', async () => {
  const owner = await lgpdUser('review-renewal@teste.local');
  const campaign = await lgpdCampaign(owner.user.id, 'Renovação concorrente', { status: 'ACTIVE' });
  await prisma.subscription.create({ data: { userId: owner.user.id, pausedAt: new Date() } });
  const original = prisma.subscription.findMany;
  prisma.subscription.findMany = (async (...args: Parameters<typeof original>) => {
    const result = await original.apply(prisma.subscription, args);
    await prisma.subscription.update({ where: { userId: owner.user.id }, data: { pausedAt: null } });
    return result;
  }) as typeof original;
  try {
    assert.equal(await pauseBlockedAccounts(new Date(), owner.user.id), 0);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE');
  } finally {
    prisma.subscription.findMany = original;
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
  }
});

test('review: pending alerts of a disconnected owner cannot starve another owner', async () => {
  await prisma.ownerAlert.deleteMany();
  const offline = await lgpdUser('review-alert-offline@teste.local');
  const online = await lgpdUser('review-alert-online@teste.local');
  const now = new Date();
  await prisma.alertSettings.createMany({ data: [offline, online].map(o => ({ userId: o.user.id, enabled: true })) });
  await prisma.ownerAlert.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ userId: offline.user.id, key: `review:off:${i}`, text: 'Aviso pendente', createdAt: new Date(now.getTime() - 60_000) })) });
  const wanted = await prisma.ownerAlert.create({ data: { userId: online.user.id, key: 'review:online', text: 'Aviso da conta conectada', createdAt: now } });
  const sent: string[] = [];
  const router = { forOwner: async (userId: string) => ({ status: () => ({ state: userId === online.user.id ? 'connected' : 'disconnected' }), notify: async (text: string) => { sent.push(text); } }) };
  assert.equal(await deliverAlerts(router, now), 1);
  assert.deepEqual(sent, [wanted.text]);
  assert.ok((await prisma.ownerAlert.findUniqueOrThrow({ where: { id: wanted.id } })).sentAt);
  assert.equal(await deliverAlerts(router, now), 0, 'aviso confirmado não é repetido');
  assert.equal(await prisma.ownerAlert.count({ where: { userId: offline.user.id, sentAt: null } }), 55);
});

test('review: the compiled server starts on an isolated port with API and panel, without a paired WhatsApp', { timeout: 30_000 }, async () => {
  await pauseEverything();
  const sessions = mkdtempSync(join(tmpdir(), 'wa-startup-'));
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('Porta de teste indisponível.'));
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const child = spawn(process.execPath, ['apps/server/dist/main.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, SESSIONS_DIR: sessions, WHATSAPP_AUTO_CONNECT: '0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Servidor isolado não iniciou no prazo.')), 20_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Servidor isolado encerrou antes de iniciar (${code}).`)); });
      let output = '';
      child.stdout.on('data', chunk => {
        output = (output + String(chunk)).slice(-4000);
        if (output.includes('Sistema pronto em')) { clearTimeout(timer); resolve(); }
      });
      // Drena o pipe sem imprimir configuração nem dados do ambiente.
      child.stderr.on('data', () => undefined);
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { database: string }).database, 'ok');
    const panel = await fetch(`${base}/campanhas`);
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /<div id="root"/);
    assert.equal((await fetch(`${base}/api/whatsapp/status`)).status, 401);
    assert.equal(existsSync(join(sessions, 'whatsapp', 'creds.json')), false);
  } finally {
    child.kill();
    await exited;
    rmSync(sessions, { recursive: true, force: true });
  }
});

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
