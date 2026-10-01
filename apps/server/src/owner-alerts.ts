import type { FastifyInstance } from 'fastify';
import { prisma, currentTime } from '@campaign/database';
import { LoginLimiter } from './auth';
import { PRODUCT_NAME } from './legal';

// Avisos no WhatsApp do dono (ADR-048). Quando uma campanha real termina, ou quando o sistema
// pausa as campanhas para proteger o número, o dono recebe uma mensagem de texto: na conversa do
// próprio número conectado ou num outro número que ele escolher.
//
// Duas etapas, as duas fora da fila de envio (queue.ts não muda):
//   1. collectAlerts olha o banco e grava um aviso por FATO (chave única: nunca avisa duas vezes);
//   2. deliverAlerts manda os avisos gravados pela conexão do próprio dono.
// Aviso não é envio de campanha: não conta no limite do dia e nunca vai para grupo.

/** Espera depois do último envio antes de dizer "terminou": uma recusa atrasada reabre a campanha. */
export const ALERT_SETTLE_MS = 2 * 60_000;
/** Aviso que não saiu neste prazo (WhatsApp desconectado) é abandonado: notícia velha não ajuda. */
export const ALERT_EXPIRY_MS = 6 * 3_600_000;
const KEEP_MS = 30 * 86_400_000;
const NOTIFY_TIMEOUT_MS = 60_000;
const ROUND_MS = 30_000;

/** O que os avisos usam de uma conexão. `notify` é opcional: conector de teste pode não ter. */
export type AlertTarget = { status(): { state: string }; notify?: (text: string, phone?: string | null) => Promise<void> };
export type AlertRouter = { forOwner(userId: string): Promise<AlertTarget | null> };

const title = (what: string) => `*${PRODUCT_NAME}* · ${what}`;
export const TEST_ALERT = `${title('Aviso de teste')}\nOs avisos estão funcionando. É por aqui que você fica sabendo quando uma campanha termina.`;

/** Texto do aviso de campanha concluída. */
export function completionText(name: string, sent: number, failed: number, link: string) {
  const total = sent + failed;
  const done = `${sent} de ${total} ${total === 1 ? 'envio feito' : 'envios feitos'}.`;
  const problems = failed ? ` ${failed} ${failed === 1 ? 'falhou' : 'falharam'}.` : '';
  return `${title('Campanha concluída')}\n"${name}": ${done}${problems}\n${link}`;
}

export class AlertError extends Error {}

/** Número de avisos em dígitos com o código do país; vazio = usar o próprio número conectado. */
export function parsePhone(value: unknown): string | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const invalid = () => new AlertError('Número de avisos inválido. Use DDD e número, como 11 91234-5678.');
  if (typeof value !== 'string' || value.length > 40) throw invalid();
  // Sem o zero da operadora, na frente ou depois do 55 ("011…", "+55 011…"): DDD não começa com 0.
  const digits = value.replace(/\D/g, '').replace(/^0+/, '').replace(/^550/, '55');
  // DDD + número, sem o código do país: é um número do Brasil.
  const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  if (full.length < 12 || full.length > 15) throw invalid();
  return full;
}

/**
 * Grava os avisos dos fatos novos das contas com avisos ligados. Devolve quantos gravou.
 * Só vale o que aconteceu depois de a conta ligar os avisos e dentro do prazo de validade.
 */
export async function collectAlerts(origin: string, now: Date, settleMs = ALERT_SETTLE_MS) {
  const accounts = await prisma.alertSettings.findMany({ where: { enabled: true, user: { disabledAt: null } }, select: { userId: true, enabledAt: true } });
  if (!accounts.length) return 0;
  const enabledAt = new Map(accounts.map(account => [account.userId, account.enabledAt ?? now]));
  const userIds = [...enabledAt.keys()];
  const since = new Date(now.getTime() - ALERT_EXPIRY_MS);
  const fresh = (userId: string, at: Date) => at >= since && at >= enabledAt.get(userId)!;
  const alerts: { userId: string; key: string; text: string }[] = [];

  // Campanha real concluída. O "quando" é o último envio tentado (updatedAt muda por outros
  // motivos, como criar o link do relatório). Uma rodada de "tentar de novo" tem outro último
  // envio, então avisa de novo ao terminar.
  const finished = await prisma.campaign.findMany({
    where: { userId: { in: userIds }, status: 'COMPLETED', provider: 'baileys', isTemplate: false, deletedAt: null, updatedAt: { gte: since } },
    select: { id: true, name: true, userId: true },
  });
  for (const campaign of finished) {
    const stats = await prisma.delivery.groupBy({ by: ['status'], where: { campaignId: campaign.id }, _count: { _all: true }, _max: { attemptedAt: true } });
    const last = stats.reduce<Date | null>((latest, row) => (row._max.attemptedAt && (!latest || row._max.attemptedAt > latest) ? row._max.attemptedAt : latest), null);
    if (!last || !fresh(campaign.userId, last) || last.getTime() > now.getTime() - settleMs) continue;
    const count = (status: string) => stats.find(row => row.status === status)?._count._all ?? 0;
    alerts.push({
      userId: campaign.userId,
      key: `fim:${campaign.id}:${last.getTime()}`,
      text: completionText(campaign.name, count('SENT'), count('FAILED'), `${origin}/campanhas/${campaign.id}`),
    });
  }

  // Pausa automática por sinal de restrição (ADR-041).
  const paused = await prisma.whatsAppSession.findMany({ where: { userId: { in: userIds }, safetyPausedAt: { gte: since } }, select: { userId: true, safetyPausedAt: true, safetyReason: true } });
  for (const session of paused) {
    if (!session.safetyPausedAt || !fresh(session.userId, session.safetyPausedAt)) continue;
    alerts.push({
      userId: session.userId,
      key: `pausa:${session.userId}:${session.safetyPausedAt.getTime()}`,
      text: `${title('Campanhas pausadas')}\n${session.safetyReason ?? 'O sistema pausou as campanhas para proteger o seu número.'}\nConfira e retome pelo painel: ${origin}/campanhas`,
    });
  }
  if (!alerts.length) return 0;
  // skipDuplicates: o fato já avisado (mesma chave) fica como está.
  return (await prisma.ownerAlert.createMany({ data: alerts.map(alert => ({ ...alert, text: alert.text.slice(0, 1000), createdAt: now })), skipDuplicates: true })).count;
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('O WhatsApp não respondeu a tempo.')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Motivo de uma falha de aviso, sem detalhe interno. */
const failureOf = (error: unknown) => (error instanceof Error && /avisos|desconectado|não respondeu|não confirmou/.test(error.message)
  ? error.message
  : 'O WhatsApp não aceitou o aviso.');

/**
 * Manda os avisos gravados, um por conta a cada rodada, pela conexão do próprio dono. Sem conexão,
 * o aviso espera (até vencer). Com um envio de campanha saindo agora, espera a próxima rodada.
 * O aviso é reservado ANTES de sair: se o envio falhar, fica o motivo e ele não é repetido.
 */
export async function deliverAlerts(router: AlertRouter, now: Date) {
  const pending = await prisma.ownerAlert.findMany({ where: { sentAt: null, error: null }, orderBy: { createdAt: 'asc' }, take: 50 });
  const handled = new Set<string>();
  let sent = 0;
  for (const alert of pending) {
    const giveUp = (error: string) => prisma.ownerAlert.updateMany({ where: { id: alert.id, sentAt: null, error: null }, data: { error } });
    if (alert.createdAt.getTime() < now.getTime() - ALERT_EXPIRY_MS) { await giveUp('Não enviado: o WhatsApp ficou desconectado.'); continue; }
    if (handled.has(alert.userId)) continue;
    const settings = await prisma.alertSettings.findUnique({ where: { userId: alert.userId } });
    if (!settings?.enabled) { await giveUp('Não enviado: os avisos foram desligados.'); continue; }
    const target = await router.forOwner(alert.userId);
    if (target?.status().state !== 'connected' || !target.notify) continue;
    if (await prisma.delivery.count({ where: { status: 'PROCESSING', campaign: { userId: alert.userId } } })) continue;
    handled.add(alert.userId);
    const claimed = await prisma.ownerAlert.updateMany({ where: { id: alert.id, sentAt: null, error: null }, data: { sentAt: now } });
    if (!claimed.count) continue;
    try {
      await withTimeout(target.notify(alert.text, settings.phone), NOTIFY_TIMEOUT_MS);
      sent++;
    } catch (error) {
      console.warn('[Avisos] Aviso não enviado:', alert.userId, error instanceof Error ? error.message : error);
      await prisma.ownerAlert.update({ where: { id: alert.id }, data: { sentAt: null, error: failureOf(error).slice(0, 255) } });
    }
  }
  return sent;
}

/** Liga a rodada de avisos (a cada 30 s). Devolve a função que para e espera a rodada em curso. */
export function startOwnerAlerts(router: AlertRouter, origin: string, options: { intervalMs?: number } = {}) {
  let stopped = false;
  let running: Promise<void> | null = null;
  let lastCleanup = 0;
  const run = () => {
    if (stopped || running) return;
    running = (async () => {
      const now = await currentTime();
      await collectAlerts(origin, now);
      await deliverAlerts(router, now);
      if (Date.now() - lastCleanup >= 3_600_000) {
        lastCleanup = Date.now();
        await prisma.ownerAlert.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
      }
    })()
      .catch(error => console.warn('[Avisos] Rodada falhou:', error instanceof Error ? error.message : error))
      .finally(() => { running = null; });
  };
  const timer = setInterval(run, options.intervalMs ?? ROUND_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

/** Primeira linha sem a marca e o resto: o que a tela mostra em "Últimos avisos". */
function summary(text: string) {
  const [first = '', ...rest] = text.split('\n');
  return { title: first.replace(/^\*[^*]+\* · /, ''), detail: rest.filter(line => !/https?:\/\//.test(line)).join(' ').trim() };
}

export function registerAlertRoutes(app: FastifyInstance, router: AlertRouter, limiter = new LoginLimiter(3, 10 * 60_000)) {
  async function view(userId: string) {
    const [settings, recent, target] = await Promise.all([
      prisma.alertSettings.findUnique({ where: { userId } }),
      prisma.ownerAlert.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 5, select: { text: true, createdAt: true, sentAt: true, error: true } }),
      router.forOwner(userId),
    ]);
    return {
      enabled: settings?.enabled ?? false,
      phone: settings?.phone ?? null,
      connected: target?.status().state === 'connected',
      recent: recent.map(({ text, ...alert }) => ({ ...summary(text), ...alert })),
    };
  }

  app.get('/api/alerts', async request => view(request.user!.id));

  app.put('/api/alerts', async (request, reply) => {
    const body = request.body as { enabled?: unknown; phone?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') return reply.code(400).send({ error: 'Diga se os avisos ficam ligados.' });
    let phone: string | null;
    try { phone = parsePhone(body.phone); }
    catch (error) {
      if (error instanceof AlertError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const userId = request.user!.id;
    const current = await prisma.alertSettings.findUnique({ where: { userId } });
    // Ligar de novo recomeça a contar: o que aconteceu com os avisos desligados não é avisado.
    const enabledAt = body.enabled ? (current?.enabled && current.enabledAt ? current.enabledAt : await currentTime()) : null;
    const data = { enabled: body.enabled, phone, enabledAt };
    await prisma.alertSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    return view(userId);
  });

  // Aviso de teste, na hora, para o destino já salvo. 3 a cada 10 min por conta.
  app.post('/api/alerts/test', async (request, reply) => {
    const userId = request.user!.id;
    const key = [`conta:${userId}`];
    const wait = limiter.blockedFor(key);
    if (wait) return reply.code(429).send({ error: `Muitos testes seguidos. Aguarde ${wait} minuto${wait > 1 ? 's' : ''}.` });
    const target = await router.forOwner(userId);
    if (target?.status().state !== 'connected' || !target.notify) return reply.code(409).send({ error: 'Conecte o WhatsApp para enviar o aviso de teste.' });
    limiter.fail(key);
    const settings = await prisma.alertSettings.findUnique({ where: { userId } });
    const now = await currentTime();
    const record = (data: { sentAt?: Date; error?: string }) => prisma.ownerAlert.create({ data: { userId, key: `teste:${userId}:${now.getTime()}`, text: TEST_ALERT, createdAt: now, ...data } }).catch(() => undefined);
    try {
      await withTimeout(target.notify(TEST_ALERT, settings?.phone ?? null), NOTIFY_TIMEOUT_MS);
    } catch (error) {
      const message = failureOf(error);
      await record({ error: message.slice(0, 255) });
      return reply.code(502).send({ error: message });
    }
    await record({ sentAt: now });
    return view(userId);
  });
}
