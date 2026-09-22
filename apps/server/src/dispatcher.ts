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
  dueOrRunning,
  holdInterruptedAccounts,
} from '@campaign/database';
import type { WhatsAppProvider } from './whatsapp';
import { isNotSent, notSent } from './send-context';

// O que o despachante usa do conector. Permite testar o fluxo inteiro com um conector falso.
export type SendingProvider = Pick<WhatsAppProvider, 'status' | 'send' | 'flushReads' | 'flushDeliveryEvents'>;

// Código técnico de uma falha, guardado à parte da mensagem legível: status do Baileys
// (Boom) ou o code de erros do Node (ex.: ETIMEDOUT).
export function errorCodeOf(error: unknown): string | undefined {
  const e = error as { output?: { statusCode?: number }; code?: unknown } | null;
  if (typeof e?.output?.statusCode === 'number') return `baileys:${e.output.statusCode}`;
  if (typeof e?.code === 'string' || typeof e?.code === 'number') return String(e.code);
  return undefined;
}

const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const SCAN_INTERVAL_MS = 5_000;
// Folga mínima entre dois envios quaisquer, em memória. NÃO é o que garante o intervalo: isso
// é o relógio persistido de cada número (WhatsAppAccount, ADR-006), conferido em claimDelivery.
const SEND_SPACING_MS = 1_500;

export type Dispatcher = {
  isActive(): boolean;
  stop(): Promise<void>;
};

export async function startDispatcher(provider: SendingProvider, options: { scanIntervalMs?: number } = {}): Promise<Dispatcher> {
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
      if (!delivery.group.active) throw notSent(new Error('Grupo inativo. Sincronize os grupos.'));
      let providerId: string;
      let context: string | undefined;
      if (delivery.provider === 'simulator') {
        providerId = `sim-${id}`;
      } else if (delivery.provider === 'baileys') {
        const media = delivery.campaign.mediaId
          ? await prisma.campaignMedia.findUniqueOrThrow({ where: { id: delivery.campaign.mediaId } })
          : null;
        const sent = await provider.send(
          delivery.group.externalId ?? '',
          delivery.messageBody,
          delivery.campaign.accountJid,
          media,
        );
        providerId = sent.messageId;
        context = sent.context;
      } else {
        throw new Error('Provedor desconhecido.');
      }
      // SENT = o WhatsApp recebeu o pedido. Entrega ou recusa chegam depois (ADR-012).
      await finishDelivery(prisma, id, { providerId, context });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha no envio.';
      // Só o que comprovadamente não saiu volta para a fila (ADR-014); o resto é incerto.
      const retryable = isNotSent(error);
      await finishDelivery(prisma, id, {
        error: retryable ? message : `${message} Resultado incerto: confira no celular. Sem reenvio automático para não duplicar.`,
        code: errorCodeOf(error),
        retryable,
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
      await provider.flushDeliveryEvents().catch(() => {
        console.warn('[WhatsApp] Não foi possível registrar entregas/recusas; nova tentativa no próximo ciclo.');
      });
      const now = await currentTime();
      const campaigns = await prisma.campaign.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          OR: [{ nextAvailableAt: null }, { nextAvailableAt: { lte: now } }],
        },
        // Quem espera há mais tempo tenta primeiro: campanhas no mesmo número se revezam.
        orderBy: [{ nextAvailableAt: 'asc' }, { createdAt: 'asc' }],
        include: {
          deliveries: {
            where: dueOrRunning(now),
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

  // O envio interrompido pode ter saído pouco antes da queda: o número espera um intervalo inteiro.
  await holdInterruptedAccounts(prisma, await currentTime());
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
  }, options.scanIntervalMs ?? SCAN_INTERVAL_MS);
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
