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
import type { SendingRouter } from './sending-router';
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
// Folga mínima entre dois envios do MESMO número, em memória. NÃO é o que garante o intervalo:
// isso é o relógio persistido de cada número (WhatsAppAccount, ADR-015), conferido em
// claimDelivery. Números diferentes não esperam um pelo outro (Fase 5, ADR-025).
const SEND_SPACING_MS = 1_500;

/**
 * Faixa de envio: um número de WhatsApp (ou a simulação). Dentro de uma faixa, um envio por
 * vez; faixas diferentes andam em paralelo.
 */
export const laneOf = (delivery: { provider: string }, campaign: { accountJid: string | null; userId: string }) =>
  delivery.provider === 'baileys' ? `numero:${campaign.accountJid ?? `sem-numero:${campaign.userId}`}` : 'simulacao';

export type Dispatcher = {
  isActive(): boolean;
  stop(): Promise<void>;
};

/**
 * O despachante não tem mais "um WhatsApp": para cada envio ele pergunta ao roteador qual é a
 * conexão DO DONO da campanha (ADR-022). Sem conexão do dono, o envio espera — nunca sai por
 * outro número e nunca é marcado como enviado.
 */
export async function startDispatcher(router: SendingRouter, options: { scanIntervalMs?: number } = {}): Promise<Dispatcher> {
  const owner = randomUUID();
  let stopping = false;
  let working = false;
  const lastSendAt = new Map<string, number>();
  let scanTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  // Faixas trabalhando agora (uma por número). Uma faixa ocupada não recebe outro lote.
  const busyLanes = new Set<string>();
  const activeLanes = new Set<Promise<void>>();

  async function send(id: string, lane: string) {
    if (stopping) return;
    // Quem envia é sempre a conexão do dono da campanha deste envio.
    const pending = await prisma.delivery.findUnique({ where: { id }, select: { provider: true, campaign: { select: { userId: true } } } });
    if (!pending) return;
    const provider = pending.provider === 'baileys' ? await router.forOwner(pending.campaign.userId) : null;
    if (pending.provider === 'baileys' && provider?.status().state !== 'connected') return; // espera o dono conectar
    const delivery = await claimDelivery(prisma, id);
    if (!delivery) return;
    lastSendAt.set(lane, Date.now());
    try {
      if (!delivery.group.active) throw notSent(new Error('Grupo inativo. Sincronize os grupos.'));
      let providerId: string;
      let context: string | undefined;
      if (delivery.provider === 'simulator') {
        providerId = `sim-${id}`;
      } else if (delivery.provider === 'baileys') {
        // Guarda extra: sem a conexão do dono, falha ANTES de qualquer envio (nada sai).
        if (!provider) throw notSent(new Error('O WhatsApp do dono desta campanha não está conectado.'));
        const media = delivery.campaign.mediaId
          ? await prisma.campaignMedia.findUniqueOrThrow({ where: { id: delivery.campaign.mediaId } })
          : null;
        const sent = await provider.send(
          delivery.group.externalId ?? '',
          delivery.messageBody,
          delivery.campaign.accountJid,
          media,
          delivery.groupId, // selo/metadata só deste grupo (ADR-022)
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
      // Recibos e eventos de CADA conexão, aplicados só aos dados do dono dela.
      for (const { ownerId, provider: connection } of await router.entries()) {
        await connection.flushReads().catch(() => {
          console.warn('[WhatsApp] Não foi possível registrar leituras de', ownerId, '; nova tentativa no próximo ciclo.');
        });
        await connection.flushDeliveryEvents().catch(() => {
          console.warn('[WhatsApp] Não foi possível registrar entregas/recusas de', ownerId, '; nova tentativa no próximo ciclo.');
        });
      }
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
        .flatMap(campaign => campaign.deliveries.map(delivery => ({ delivery, ownerId: campaign.userId, lane: laneOf(delivery, campaign) })))
        .filter(({ delivery }) => delivery.status === 'PENDING' && delivery.scheduledAt <= now);
      // Uma fila por número; os números andam em paralelo (Fase 5). A ordem dentro de cada
      // faixa é a do scan: quem espera há mais tempo primeiro.
      const lanes = new Map<string, typeof due>();
      for (const item of due) lanes.set(item.lane, [...(lanes.get(item.lane) ?? []), item]);
      // A rodada só entrega trabalho às faixas livres e NÃO espera por elas: um número lento
      // não segura os outros (cada faixa é independente).
      for (const [lane, items] of lanes) {
        if (stopping || busyLanes.has(lane)) continue;
        busyLanes.add(lane);
        const running = runLane(lane, items)
          .catch(error => console.error('Falha na fila do número:', error instanceof Error ? error.message : 'erro'))
          .finally(() => { busyLanes.delete(lane); activeLanes.delete(running); });
        activeLanes.add(running);
      }
    } catch (error) {
      console.error('Falha ao reconciliar fila:', error instanceof Error ? error.message : 'erro');
    } finally {
      working = false;
    }
  }

  async function runLane(lane: string, items: { delivery: { id: string; provider: string }; ownerId: string }[]) {
    for (const { delivery, ownerId } of items) {
      if (stopping) break;
      // Sem conexão do dono, este envio espera; os das outras campanhas seguem.
      if (delivery.provider === 'baileys' && (await router.forOwner(ownerId))?.status().state !== 'connected') continue;
      const wait = SEND_SPACING_MS - (Date.now() - (lastSendAt.get(lane) ?? 0));
      if (wait > 0) await delay(wait);
      if (stopping) break;
      await send(delivery.id, lane);
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
    // Espera os envios em andamento de TODOS os números (até 30 s). Cada faixa confere
    // `stopping` antes de enviar, então nenhuma começa um envio novo.
    if (activeLanes.size) await Promise.race([Promise.allSettled([...activeLanes]), delay(30_000)]);
    await releaseLease(prisma, owner).catch(() => {});
  }

  return {
    isActive: () => !stopping,
    stop,
  };
}
