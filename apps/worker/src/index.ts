import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma, claimDelivery, finishDelivery, completeFinished, currentTime } from '@campaign/database';
import { WhatsAppProvider } from './whatsapp';

// O PostgreSQL é a fila. Não há Redis nem BullMQ: a correção do envio sempre
// veio de claimDelivery (reserva transacional sob lock da campanha), não do
// despachante. Ver ADR-008.
const LEASE_ID = 'worker';
const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const SCAN_INTERVAL_MS = 5_000;
// Piso de segurança entre chamadas externas, independente do intervalo da
// campanha. Equivale ao limiter `max: 1 / 1500ms` que o BullMQ aplicava.
const SEND_SPACING_MS = 1_500;

const provider = new WhatsAppProvider();
const owner = randomUUID();
let stopping = false;
let working = false;
let lastSendAt = 0;
let leaseTimer: NodeJS.Timeout;
let scanTimer: NodeJS.Timeout;

const app = Fastify({ logger: false });
app.addHook('onRequest', async (request, reply) => {
  if (!['localhost', '127.0.0.1'].includes(request.hostname)) return reply.code(403).send({ error: 'Use localhost.' });
  reply.header('Cache-Control', 'no-store');
  // Internal loopback service. Browser requests must go through the API.
  if (request.headers.origin) return reply.code(403).send({ error: 'Use o painel.' });
});
app.setErrorHandler((error, _request, reply) => { reply.code(400).send({ error: error instanceof Error ? error.message : 'Falha no conector.' }); });
app.get('/status', async () => provider.status());
app.post('/connect', async () => provider.connect());
app.post('/disconnect', async () => provider.disconnect());
app.post('/sync', async () => provider.sync());

// Um processador por vez. A linha é tomada apenas se estiver livre, vencida ou
// já for nossa; o UPDATE condicional torna a disputa atômica no banco.
async function acquireLease() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const rows = await prisma.$executeRaw`
    INSERT INTO "WorkerLease" ("id", "ownerId", "expiresAt", "updatedAt")
    VALUES (${LEASE_ID}, ${owner}, ${expiresAt}, ${now})
    ON CONFLICT ("id") DO UPDATE
       SET "ownerId" = ${owner}, "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
     WHERE "WorkerLease"."expiresAt" < ${now} OR "WorkerLease"."ownerId" = ${owner}`;
  return rows > 0;
}

async function renewLease() {
  const renewed = await prisma.workerLease.updateMany({
    where: { id: LEASE_ID, ownerId: owner },
    data: { expiresAt: new Date(Date.now() + LEASE_TTL_MS) }
  });
  return renewed.count > 0;
}

async function send(id: string) {
  if (stopping) return;
  if (provider.status().state !== 'connected') {
    const pending = await prisma.delivery.findUnique({ where: { id } });
    if (pending?.provider === 'baileys') return;
  }
  const delivery = await claimDelivery(prisma, id);
  if (!delivery) return;
  lastSendAt = Date.now();
  try {
    if (!delivery.group.active) throw new Error('Grupo inativo.');
    let providerId: string;
    if (delivery.provider === 'simulator') providerId = `sim-${id}`;
    else if (delivery.provider === 'baileys') {
      const media = delivery.campaign.mediaId ? await prisma.campaignMedia.findUniqueOrThrow({ where: { id: delivery.campaign.mediaId } }) : null;
      providerId = await provider.send(delivery.group.externalId ?? '', delivery.messageBody, delivery.campaign.accountJid, media);
    }
    else throw new Error('Provedor desconhecido.');
    await finishDelivery(prisma, id, { providerId });
  } catch (error) {
    await finishDelivery(prisma, id, { error: `${error instanceof Error ? error.message : 'Falha no envio'} Resultado pode ser incerto. Sem repetição automática para evitar duplicatas.` });
  }
}

async function scan() {
  if (working || stopping) return;
  working = true;
  try {
    await completeFinished(prisma);
    await provider.flushReads().catch(() => console.warn('[WhatsApp] Não foi possível registrar leituras; nova tentativa no próximo ciclo.'));
    const now = await currentTime();
    const campaigns = await prisma.campaign.findMany({
      where: { status: 'ACTIVE', deletedAt: null, OR: [{ nextAvailableAt: null }, { nextAvailableAt: { lte: now } }] },
      include: { deliveries: { where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { sequence: 'asc' }, take: 1 } }
    });
    const due = campaigns.flatMap(campaign => campaign.deliveries).filter(delivery => delivery.status === 'PENDING' && delivery.scheduledAt <= now);
    for (const delivery of due) {
      if (stopping) break;
      if (delivery.provider === 'baileys' && provider.status().state !== 'connected') continue;
      const wait = SEND_SPACING_MS - (Date.now() - lastSendAt);
      if (wait > 0) await delay(wait);
      // Sequencial por escolha: uma chamada externa por vez, como antes.
      await send(delivery.id);
    }
  } catch (error) { console.error('Falha ao reconciliar fila:', error instanceof Error ? error.message : 'erro'); }
  finally { working = false; }
}

async function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(scanTimer); clearInterval(leaseTimer);
  await provider.stop();
  await app.close();
  await prisma.workerLease.deleteMany({ where: { id: LEASE_ID, ownerId: owner } }).catch(() => {});
  await prisma.$disconnect();
}

async function main() {
  if (!await acquireLease()) throw new Error('Já existe um worker ativo. Encerre-o antes de iniciar outro.');
  leaseTimer = setInterval(() => {
    void renewLease().then(ok => { if (!ok) return shutdown(); }).catch(() => { void shutdown(); });
  }, LEASE_RENEW_MS);
  // Só depois do lease: a posse é a prova de que nenhum outro processo está
  // enviando. Uma reserva órfã nunca é repetida — o resultado é incerto.
  await prisma.delivery.updateMany({ where: { status: 'PROCESSING' }, data: { status: 'FAILED', error: 'Processo interrompido durante envio. Resultado incerto: confira no celular. Sem repetição automática.' } });
  await app.listen({ port: 3002, host: '127.0.0.1' });
  scanTimer = setInterval(() => { void scan(); }, SCAN_INTERVAL_MS);
  await scan();
  console.log('Worker pronto. Conecte o WhatsApp pelo painel; nenhuma sessão é iniciada automaticamente.');
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
main().catch(error => { console.error(error.message); process.exit(1); });
