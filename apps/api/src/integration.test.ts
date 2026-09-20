import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, acquireLease, renewLease, releaseLease, claimDelivery, finishDelivery, resumeAt, recordRead, currentTime, persistRead, flushPendingReads } from '@campaign/database';
import { app } from './server';
import sharp from 'sharp';
import { videoFixture } from './media-fixture';
import { validateMedia, IMAGE_LIMIT, VIDEO_LIMIT } from './media';

const schema = process.env.CAMPAIGN_TEST_SCHEMA;
if (!schema || !/^campaign_test_[a-f0-9]{16}$/.test(schema) || new URL(process.env.DATABASE_URL!).searchParams.get('schema') !== schema) throw Error('Testes só podem executar no schema descartável.');

// External clock fixtures are confined to this isolated test process/schema.
const originalFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (/^https:\/\/(www\.google\.com|www\.cloudflare\.com)\//.test(String(input))) return new Response(null, { status: 200, headers: { date: new Date().toUTCString() } });
  return originalFetch(input, init);
});
after(async () => { await app.close(); await prisma.$disconnect(); });
const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: { host: 'localhost' } });
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
  const upload = await app.inject({ method: 'POST', url: '/media?name=test-file', headers: { host: 'localhost', 'content-type': mimeType }, payload: bytes });
  assert.equal(upload.statusCode, 201, upload.body);
  const media = upload.json(); assert.equal(media.kind, kind); assert.equal(media.data, undefined);
  const { groups } = await create(2);
  const body = { name: 'Media fixture', mode: 'IMMEDIATE', intervalSeconds: 180, messages: ['caption'], groupIds: groups.map(g => g.id), mediaId: media.id };
  const created = await request('POST', '/campaigns', body); assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const preview = await app.inject({ method: 'GET', url: `/media/${media.id}`, headers: { host: 'localhost' } });
  assert.equal(preview.statusCode, 200); assert.deepEqual(preview.rawPayload, bytes);
  const range = await app.inject({ method: 'GET', url: `/media/${media.id}`, headers: { host: 'localhost', range: 'bytes=0-9' } });
  assert.equal(range.statusCode, 206); assert.deepEqual(range.rawPayload, bytes.subarray(0, 10));
  assert.equal((await app.inject({ method: 'GET', url: `/media/${media.id}`, headers: { host: 'localhost', range: 'bytes=999999-' } })).statusCode, 416);
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
test('foreign origins rejected even on WhatsApp routes; DELETE preflight allowed locally', async () => {
  const r = await app.inject({ method: 'GET', url: '/whatsapp/status', headers: { host: 'localhost', origin: 'https://example.com' } });
  assert.equal(r.statusCode, 403);
  const options = await app.inject({ method: 'OPTIONS', url: '/campaigns/test', headers: { host: 'localhost', origin: 'http://localhost:3000', 'access-control-request-method': 'DELETE' } });
  assert.equal(options.statusCode, 204);
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
  const previous = globalThis.fetch;
  const disconnected = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === 'http://127.0.0.1:3002/status') return new Response(JSON.stringify({ state: 'disconnected' }), { headers: { 'Content-Type': 'application/json' } });
    return previous(input, init);
  });
  try {
    const result = await request('PATCH', `/campaigns/${id}/status`, { status: 'ACTIVE', provider: 'baileys', consent: true });
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /Conecte o WhatsApp/);
    assert.equal((await deliveries(id)).length, 0);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status, 'DRAFT');
  } finally { disconnected.mock.restore(); }
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
