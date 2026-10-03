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
  confirmLateSend,
  releaseStuckSends,
  SEND_TIMEOUT_CODE,
  SEND_TIMEOUT_ERROR,
} from '@campaign/database';
import type { WhatsAppProvider } from './whatsapp';
import type { SendingRouter } from './sending-router';
import { isNotSent, notSent } from './send-context';
import { checkRejections, recoverConfirmedRejections, isRateLimit, safetyPause, SAFETY_REASONS } from './safety';

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

// Acorda o despachante na hora (ex.: campanha acabou de ser iniciada), em vez de esperar a
// próxima varredura de 5 s. Só antecipa a varredura: as regras de fila e intervalo são as mesmas.
let wake: (() => void) | null = null;
export function wakeDispatcher() { wake?.(); }

// Envio segurado pelas regras da conta (ADR-041: silêncio, limite do dia, intervalo do grupo):
// o despachante não tenta de novo antes de a regra liberar (no máximo 5 min, para uma mudança nas
// regras valer logo). Salvar as regras solta tudo na hora.
const RULE_HOLD_MAX_MS = 5 * 60_000;

// Vigia do envio (ADR-044). 5 min cobre o upload de um vídeo grande (teto de 3 min) mais as
// consultas do grupo; passou disso, o WhatsApp não vai responder. A faxina pega o que escapar.
export const SEND_TIMEOUT_MS = 5 * 60_000;
const STUCK_GRACE_MS = 2 * 60_000;
const TIMED_OUT = Symbol('sem resposta');
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
let releaseHolds: (() => void) | null = null;
export function releaseRuleHolds() { releaseHolds?.(); wake?.(); }

export type Dispatcher = {
  isActive(): boolean;
  stop(): Promise<void>;
};

/**
 * O despachante não tem mais "um WhatsApp": para cada envio ele pergunta ao roteador qual é a
 * conexão DO DONO da campanha (ADR-022). Sem conexão do dono, o envio espera — nunca sai por
 * outro número e nunca é marcado como enviado.
 */
export async function startDispatcher(router: SendingRouter, options: { scanIntervalMs?: number; leaseRenewMs?: number; sendTimeoutMs?: number; onLeaseLost?: (reason: string) => void } = {}): Promise<Dispatcher> {
  const owner = randomUUID();
  let stopping = false;
  let working = false;
  const lastSendAt = new Map<string, number>();
  let scanTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  // Faixas trabalhando agora (uma por número). Uma faixa ocupada não recebe outro lote.
  const busyLanes = new Set<string>();
  const activeLanes = new Set<Promise<void>>();
  const holds = new Map<string, number>();
  const sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  // Envios saindo agora neste processo (a faxina não mexe neles).
  const inFlight = new Set<string>();
  let lastRejectionCheck = 0;
  releaseHolds = () => holds.clear();

  async function send(id: string, lane: string) {
    if (stopping) return;
    // Quem envia é sempre a conexão do dono da campanha deste envio.
    const pending = await prisma.delivery.findUnique({ where: { id }, select: { provider: true, campaign: { select: { userId: true } } } });
    if (!pending) return;
    const provider = pending.provider === 'baileys' ? await router.forOwner(pending.campaign.userId) : null;
    if (pending.provider === 'baileys' && provider?.status().state !== 'connected') return; // espera o dono conectar
    const delivery = await claimDelivery(prisma, id, undefined, block => holds.set(id, Math.min(block.until.getTime(), Date.now() + RULE_HOLD_MAX_MS)));
    if (!delivery) return;
    holds.delete(id);
    lastSendAt.set(lane, Date.now());
    inFlight.add(id);
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
        const sending = provider.send(
          delivery.group.externalId ?? '',
          delivery.messageBody,
          delivery.campaign.accountJid,
          media,
          delivery.groupId, // selo/metadata só deste grupo (ADR-022)
          { mentionAll: delivery.campaign.mentionAll },
        );
        // Vigia (ADR-044): sem resposta a tempo, o envio vira incerto e a fila do número anda. A
        // conexão emperrada é renovada; se a resposta chegar depois, o envio vira "enviado".
        const sent = await withTimeout(sending, sendTimeoutMs);
        if (sent === TIMED_OUT) {
          console.warn('[Fila] Envio sem resposta do WhatsApp em', Math.round(sendTimeoutMs / 1000), 's:', id);
          await finishDelivery(prisma, id, { error: SEND_TIMEOUT_ERROR, code: SEND_TIMEOUT_CODE, retryable: false });
          void sending.then(late => confirmLateSend(prisma, id, late.messageId, late.context)).then(ok => {
            if (ok) console.info('[Fila] Resposta atrasada do WhatsApp: o envio saiu.', id);
          }).catch(() => undefined);
          (provider as { recycle?: (reason: string) => void }).recycle?.('envio sem resposta do WhatsApp');
          return;
        }
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
      const code = errorCodeOf(error);
      await finishDelivery(prisma, id, {
        error: retryable ? message : `${message} Resultado incerto: confira no celular. Sem reenvio automático para não duplicar.`,
        code,
        retryable,
      });
      // O WhatsApp limitou o número: parar tudo agora, antes do próximo envio (ADR-041).
      if (delivery.provider === 'baileys' && isRateLimit(error, code)) await safetyPause(pending.campaign.userId, SAFETY_REASONS.rateLimited).catch(() => undefined);
    } finally {
      inFlight.delete(id);
    }
  }

  async function scan() {
    if (working || stopping) return;
    working = true;
    try {
      for (const [id, until] of holds) if (until <= Date.now()) holds.delete(id);
      await completeFinished(prisma);
      // Recibos e eventos de CADA conexão, aplicados só aos dados do dono dela.
      const connections = await router.entries();
      for (const { ownerId, provider: connection } of connections) {
        await connection.flushReads().catch(() => {
          console.warn('[WhatsApp] Não foi possível registrar leituras de', ownerId, '; nova tentativa no próximo ciclo.');
        });
        await connection.flushDeliveryEvents().catch(() => {
          console.warn('[WhatsApp] Não foi possível registrar entregas/recusas de', ownerId, '; nova tentativa no próximo ciclo.');
        });
      }
      const now = await currentTime();
      // Primeiro grava os recibos; só então avalia recusas ou desfaz um falso alarme.
      if (Date.now() - lastRejectionCheck >= 60_000) {
        lastRejectionCheck = Date.now();
        const released = await releaseStuckSends(prisma, sendTimeoutMs + STUCK_GRACE_MS, inFlight).catch(() => 0);
        if (released) console.warn('[Fila] Envios travados liberados:', released);
        await checkRejections(now).catch(error => console.warn('[Proteção] Falha ao conferir recusas:', error instanceof Error ? error.message : error));
        await recoverConfirmedRejections(ownerId => {
          const status = connections.find(entry => entry.ownerId === ownerId)?.provider.status();
          return status?.state === 'connected' ? status.accountJid ?? null : null;
        }, now).catch(error => console.warn('[Proteção] Falha ao conferir falso alarme:', error instanceof Error ? error.message : error));
      }
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
      if ((holds.get(delivery.id) ?? 0) > Date.now()) continue;
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

  try {
    // O envio interrompido pode ter saído pouco antes da queda: o número espera um intervalo inteiro.
    await holdInterruptedAccounts(prisma, await currentTime());
    await prisma.delivery.updateMany({
      where: { status: 'PROCESSING' },
      data: {
        status: 'FAILED',
        error: 'Processo interrompido durante envio. Resultado incerto: confira no celular. Sem repetição automática.',
      },
    });
  } catch (error) {
    await releaseLease(prisma, owner).catch(() => undefined);
    throw error;
  }
  let leaseLost = false;
  function lost(reason: string) {
    if (stopping || leaseLost) return;
    leaseLost = true;
    console.error('[Fila] Posse perdida:', reason);
    void stop().catch(error => console.error('[Fila] Falha ao parar após perder a posse:', error)).finally(() => options.onLeaseLost?.(reason));
  }
  // Uma falha passageira do banco (MySQL reiniciando, rede oscilando) não derruba o sistema: a
  // posse ainda vale até LEASE_TTL_MS depois da última renovação. Só desiste quando outro processo
  // assumiu (renovação recusada) ou quando o banco ficou fora tempo suficiente para a posse vencer.
  let lastRenewedAt = Date.now();
  leaseTimer = setInterval(() => {
    void renewLease(prisma, owner, LEASE_TTL_MS).then(ok => {
      if (ok) lastRenewedAt = Date.now();
      else lost('outro processo assumiu ou a posse expirou');
    }).catch(error => {
      const reason = error instanceof Error ? error.message : 'não foi possível renovar a posse';
      if (Date.now() - lastRenewedAt >= LEASE_TTL_MS) lost(reason);
      else console.warn('[Fila] Renovação da posse falhou; tento de novo em instantes:', reason);
    });
  }, options.leaseRenewMs ?? LEASE_RENEW_MS);
  scanTimer = setInterval(() => {
    void scan();
  }, options.scanIntervalMs ?? SCAN_INTERVAL_MS);
  wake = () => { void scan(); };
  await scan();

  async function stop() {
    if (stopping) return;
    stopping = true;
    wake = null;
    releaseHolds = null;
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
