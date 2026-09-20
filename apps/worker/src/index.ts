import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma, claimDelivery, finishDelivery, completeFinished, currentTime } from '@campaign/database';
import { WhatsAppProvider } from './whatsapp';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const provider = new WhatsAppProvider();
const queue = new Queue('deliveries', { connection });
const owner = randomUUID();
let stopping = false;
let scanning = false;
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

async function scan() {
  if (scanning || stopping) return;
  scanning = true;
  try {
    await completeFinished(prisma);
    await provider.flushReads().catch(() => console.warn('[WhatsApp] Não foi possível registrar leituras; nova tentativa no próximo ciclo.'));
    const now = await currentTime();
    const campaigns = await prisma.campaign.findMany({ where: { status: 'ACTIVE', deletedAt: null, OR: [{ nextAvailableAt: null }, { nextAvailableAt: { lte: now } }] }, include: { deliveries: { where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { sequence: 'asc' }, take: 1 } } });
    const due = campaigns.flatMap(c => c.deliveries).filter(d => d.status === 'PENDING' && d.scheduledAt <= now);
    for (const delivery of due) {
      if (delivery.provider === 'baileys' && provider.status().state !== 'connected') continue;
      const previous = await queue.getJob(delivery.id);
      if (previous && ['completed', 'failed'].includes(await previous.getState())) await previous.remove();
      await queue.add('deliver', { deliveryId: delivery.id }, { jobId: delivery.id, attempts: 1, removeOnComplete: true, removeOnFail: true });
    }
  } catch (error) { console.error('Falha ao reconciliar fila:', error instanceof Error ? error.message : 'erro'); }
  finally { scanning = false; }
}

let worker: Worker | undefined;
function createWorker() {
return new Worker('deliveries', async job => {
  if (stopping) return;
  const id = job.data.deliveryId as string;
  if (provider.status().state !== 'connected') {
    const delivery = await prisma.delivery.findUnique({ where: { id } });
    if (delivery?.provider === 'baileys') return;
  }
  const delivery = await claimDelivery(prisma, id);
  if (!delivery) return;
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
}, { connection, concurrency: 1, autorun: false, limiter: { max: 1, duration: 1500 } });
}

async function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(scanTimer); clearInterval(leaseTimer);
  await provider.stop();
  await worker?.close(); await queue.close(); await app.close(); await prisma.$disconnect();
  await connection.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0", 1, 'campaign:worker-owner', owner);
  await connection.quit();
}
async function main() {
  if ((await queue.getWorkers()).length) throw new Error('Há um worker antigo usando a fila. Encerre o processo antigo antes de iniciar esta versão.');
  if (await connection.set('campaign:worker-owner', owner, 'EX', 30, 'NX') !== 'OK') throw new Error('Já existe um worker ativo. Encerre-o antes de iniciar outro.');
  leaseTimer = setInterval(() => {
    void connection.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],30) end return 0", 1, 'campaign:worker-owner', owner)
      .then(ok => { if (!ok) return shutdown(); }).catch(() => { void shutdown(); });
  }, 10000);
  await prisma.delivery.updateMany({ where: { status: 'PROCESSING' }, data: { status: 'FAILED', error: 'Processo interrompido durante envio. Resultado incerto: confira no celular. Sem repetição automática.' } });
  await app.listen({ port: 3002, host: '127.0.0.1' });
  // Construction registers a Redis client even with autorun:false. Only create
  // our worker after checking for older instances, otherwise we detect ourselves.
  worker = createWorker();
  worker.on('error', error => console.error('Fila:', error.message));
  void worker.run();
  scanTimer = setInterval(() => { void scan(); }, 5000);
  await scan();
  console.log('Worker pronto. Conecte o WhatsApp pelo painel; nenhuma sessão é iniciada automaticamente.');
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
main().catch(error => { console.error(error.message); process.exit(1); });
