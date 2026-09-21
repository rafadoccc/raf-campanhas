import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  prisma,
  claimDelivery,
  finishDelivery,
  completeFinished,
  currentTime,
  acquireLease,
  renewLease,
  releaseLease,
} from '@campaign/database';
import type { WhatsAppProvider } from './whatsapp';

const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const SCAN_INTERVAL_MS = 5_000;
const SEND_SPACING_MS = 1_500;

export type Dispatcher = {
  isActive(): boolean;
  stop(): Promise<void>;
};

export async function startDispatcher(provider: WhatsAppProvider): Promise<Dispatcher> {
  const owner = randomUUID();
  let stopping = false;
  let working = false;
  let lastSendAt = 0;
  let scanTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let activeSend: Promise<void> | undefined;

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
      if (delivery.provider === 'simulator') {
        providerId = `sim-${id}`;
      } else if (delivery.provider === 'baileys') {
        const media = delivery.campaign.mediaId
          ? await prisma.campaignMedia.findUniqueOrThrow({ where: { id: delivery.campaign.mediaId } })
          : null;
        providerId = await provider.send(
          delivery.group.externalId ?? '',
          delivery.messageBody,
          delivery.campaign.accountJid,
          media,
        );
      } else {
        throw new Error('Provedor desconhecido.');
      }
      await finishDelivery(prisma, id, { providerId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha no envio';
      await finishDelivery(prisma, id, {
        error: `${message} Resultado pode ser incerto. Sem repetição automática para evitar duplicatas.`,
      });
    }
  }

  async function scan() {
    if (working || stopping) return;
    working = true;
    try {
      await completeFinished(prisma);
      await provider.flushReads().catch(() => {
        console.warn('[WhatsApp] Não foi possível registrar leituras; nova tentativa no próximo ciclo.');
      });
      const now = await currentTime();
      const campaigns = await prisma.campaign.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          OR: [{ nextAvailableAt: null }, { nextAvailableAt: { lte: now } }],
        },
        include: {
          deliveries: {
            where: { status: { in: ['PENDING', 'PROCESSING'] } },
            orderBy: { sequence: 'asc' },
            take: 1,
          },
        },
      });
      const due = campaigns
        .flatMap(campaign => campaign.deliveries)
        .filter(delivery => delivery.status === 'PENDING' && delivery.scheduledAt <= now);
      for (const delivery of due) {
        if (stopping) break;
        if (delivery.provider === 'baileys' && provider.status().state !== 'connected') continue;
        const wait = SEND_SPACING_MS - (Date.now() - lastSendAt);
        if (wait > 0) await delay(wait);
        activeSend = send(delivery.id);
        await activeSend;
        activeSend = undefined;
      }
    } catch (error) {
      console.error('Falha ao reconciliar fila:', error instanceof Error ? error.message : 'erro');
    } finally {
      working = false;
    }
  }

  const deadline = Date.now() + LEASE_TTL_MS + LEASE_RENEW_MS;
  let announced = false;
  while (!await acquireLease(prisma, owner, LEASE_TTL_MS)) {
    if (Date.now() > deadline) {
      throw new Error('Já existe um despachante ativo. Encerre-o antes de iniciar outro.');
    }
    if (!announced) {
      console.log('Aguardando o processo anterior liberar a posse (até 40 s)…');
      announced = true;
    }
    await delay(2_000);
  }

  await prisma.delivery.updateMany({
    where: { status: 'PROCESSING' },
    data: {
      status: 'FAILED',
      error: 'Processo interrompido durante envio. Resultado incerto: confira no celular. Sem repetição automática.',
    },
  });
  leaseTimer = setInterval(() => {
    void renewLease(prisma, owner, LEASE_TTL_MS).then(ok => {
      if (!ok) void stop();
    }).catch(() => {
      void stop();
    });
  }, LEASE_RENEW_MS);
  scanTimer = setInterval(() => {
    void scan();
  }, SCAN_INTERVAL_MS);
  await scan();

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (scanTimer) clearInterval(scanTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    if (activeSend) await Promise.race([activeSend, delay(30_000)]);
    await releaseLease(prisma, owner).catch(() => {});
  }

  return {
    isActive: () => !stopping,
    stop,
  };
}
