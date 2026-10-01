import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { prisma, persistRead, flushPendingReads, applyServerEvent, type ServerEvent } from '@campaign/database';
import { describeGroupForSend, mentionTargets, notSent, mentionAllMode, withMentionAllToken, mentionAllSample, DEFAULT_MENTION_ALL_TOKEN } from './send-context';
import { writeAtomic, peekSessionJson } from './auth-state';
import { SessionKeyError } from './session-crypto';
import QRCode from 'qrcode';
import { handleCompanionRegRefresh, withAdvSecret } from './pairing';
import { closeAction, retryDelay, CODE } from './connection-policy';
import { safetyPause, SAFETY_REASONS } from './safety';
import { useDurableAuthState } from './auth-state';
import { SessionLock } from './session-lock';
import type { WASocket, WAVersion } from '@whiskeysockets/baileys';

// Nome exibido de um grupo sincronizado: assunto sem espaços extras, limitado à coluna
// (VARCHAR 255); sem assunto, usa o número do grupo para continuar identificável.
export function groupName(subject: string | null | undefined, jid: string) {
  const clean = (subject ?? '').replace(/\s+/g, ' ').trim();
  return (clean || `Grupo ${jid.split('@')[0]}`).slice(0, 255);
}

export async function resolveWebVersion(fetchVersion: () => Promise<{ version: WAVersion; isLatest: boolean }>): Promise<WAVersion> {
  const result = await fetchVersion();
  if (!result.isLatest || result.version.length !== 3 || !result.version.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Não foi possível confirmar a versão atual do WhatsApp Web. Tente novamente mais tarde.');
  }
  return result.version;
}
// Versão do WhatsApp Web: dado público, igual para todo mundo. Com vários providers no mesmo
// processo, buscar uma vez evita N consultas na partida. NADA além disso é compartilhado.
let protocolVersion: Promise<WAVersion> | undefined;
export async function sharedProtocolVersion(fetchVersion: () => Promise<{ version: WAVersion; isLatest: boolean }>) {
  try {
    return await (protocolVersion ??= resolveWebVersion(fetchVersion));
  } catch (error) {
    protocolVersion = undefined; // falhou: a próxima tentativa consulta de novo
    throw error;
  }
}
/** Esquece a versão em cache (ex.: depois de um logout). */
export const forgetProtocolVersion = () => { protocolVersion = undefined; };

const onRailway = () => Boolean(process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

/**
 * A sessão sobrevive a um novo deploy? No Railway, só num Volume: o disco do contêiner é
 * apagado a cada deploy, e cada deploy pedia QR de novo (ADR-036).
 */
export function sessionsPersistent() {
  if (!onRailway()) return true;
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!mount) return false;
  const inside = path.relative(path.resolve(mount), defaultSessionsDir());
  return !inside.startsWith('..') && !path.isAbsolute(inside);
}

export function defaultSessionsDir() {
  if (process.env.SESSIONS_DIR) return path.resolve(process.env.SESSIONS_DIR);
  // Railway com Volume e sem SESSIONS_DIR: guarda no Volume, que sobrevive aos deploys.
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH), 'sessions');
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'raf-campanhas', 'sessions');
  }
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'raf-campanhas', 'sessions');
}

// Participantes buscados no preparo de um envio valem para o próprio envio logo em seguida.
const GROUP_CACHE_MS = 60_000;
/** Teto do upload de uma mídia (vídeo de até 64 MB numa conexão ruim). */
export const MEDIA_UPLOAD_TIMEOUT_MS = 3 * 60_000;
type GroupMetadata = Awaited<ReturnType<WASocket['groupMetadata']>>;

export class WhatsAppProvider {
  private socket?: WASocket;
  private groupCache = new Map<string, { metadata: GroupMetadata; at: number }>();
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private retries = 0;
  private wanted = false;
  private starting = false;
  private interactive = false;
  private lock?: SessionLock;
  private version?: WAVersion;
  private receiptWrites = new Set<Promise<void>>();
  private credsSaving: Promise<void> = Promise.resolve();
  private authDir: string;
  /** Dono da conexão (ADR-020). null = sessão global legada, o caminho de produção de hoje. */
  readonly ownerId: string | null;
  private current: { state: string; qr?: string; accountJid?: string; error?: string } = { state: 'disconnected' };
  /** Avisado a cada troca de estado (conectando → conectado → caiu…), para o dono gravar no banco. */
  private readonly onStateChange?: () => void;
  private get data() { return this.current; }
  private set data(value: { state: string; qr?: string; accountJid?: string; error?: string }) {
    const changed = value.state !== this.current.state || value.accountJid !== this.current.accountJid;
    this.current = value;
    if (changed) this.onStateChange?.();
  }
  /**
   * Sem argumento ou com uma pasta base: sessão GLOBAL legada (`<base>/whatsapp`), exatamente
   * como sempre foi. Com `{ ownerId, sessionDir }`: sessão daquele usuário, na pasta que o
   * WhatsAppManager calculou (session-paths.ts). Um provider nunca descobre o dono sozinho.
   */
  /** Sessão global legada (pasta antiga), mesmo quando já tem dono resolvido pela ponte. */
  readonly legacySession: boolean;
  constructor(options: string | { ownerId: string; sessionDir: string; legacySession?: boolean; onStateChange?: () => void } = defaultSessionsDir()) {
    if (typeof options === 'string') {
      this.ownerId = null;
      this.authDir = path.join(options, 'whatsapp');
      this.legacySession = true;
    } else {
      if (!options.ownerId || !options.sessionDir) throw new Error('Conexão por usuário exige ownerId e sessionDir.');
      this.ownerId = options.ownerId;
      this.authDir = options.sessionDir;
      this.legacySession = options.legacySession ?? false;
      this.onStateChange = options.onStateChange;
    }
  }
  /** Pasta de sessão desta conexão (só leitura; cada provider tem a sua). */
  get sessionDir() { return this.authDir; }
  status() { return { ...this.data }; }
  /** Há uma sessão já pareada salva (ou a cópia de segurança dela)? Reconectar não exige QR. */
  async hasPairedSession() {
    for (const file of ['creds.json', 'creds.json.bak']) {
      const creds = await peekSessionJson<{ me?: { id?: string } }>(path.join(this.authDir, file));
      // Cifrada e sem a chave certa (ADR-046): há uma sessão ali. Dizer "não há" faria o sistema
      // tratar a conta como nunca pareada; abrir a conexão mostra o erro da chave.
      if (creds === 'locked' || creds?.me?.id) return true;
    }
    return false;
  }
  /**
   * interactive: alguém clicou em Conectar e está olhando a tela — pode aparecer QR. Sem isso
   * (partida do sistema, reconexão depois de uma queda), um QR quer dizer que o WhatsApp não
   * reconhece mais o aparelho: a conexão para com o motivo, em vez de gerar QR para ninguém.
   */
  async connect(options: { interactive?: boolean } = {}) {
    if (this.starting || ['connected', 'connecting', 'qr', 'reconnecting'].includes(this.data.state)) return this.status();
    this.wanted = true; this.retries = 0;
    this.interactive = options.interactive ?? true;
    await this.open();
    return this.status();
  }
  private async open() {
    this.starting = true;
    const generation = ++this.generation;
    this.data = { state: 'connecting' };
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const { default: makeWASocket, jidNormalizedUser, fetchLatestWaWebVersion, proto, makeCacheableSignalKeyStore } = baileys;
      const { default: pino } = await import('pino');
      // Keep the verified version across reconnects; never silently downgrade.
      this.version ??= await sharedProtocolVersion(() => fetchLatestWaWebVersion({ signal: AbortSignal.timeout(15000) }));
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      // Uma pasta de sessão, um processo (session-lock.ts): outro sistema ligado com a mesma pasta
      // abriria uma segunda conexão com as MESMAS credenciais; o WhatsApp derruba uma com a outra
      // (440) e as duas gravam as mesmas chaves. Espera o outro sair, sem desistir.
      this.lock ??= new SessionLock(`${this.authDir}.lock`);
      const lock = await this.lock.acquire();
      if (!this.wanted || generation !== this.generation) {
        if (lock.ok) await this.lock.release().catch(() => undefined);
        return;
      }
      if (!lock.ok) {
        console.warn('[WhatsApp] Pasta de sessão em uso por outro processo:', `pid ${lock.owner.pid} em ${lock.owner.host}`, this.authDir);
        this.scheduleReconnect(30_000, false, 'Esta sessão do WhatsApp está aberta em outro sistema ligado (produção ou dev com a mesma pasta de sessões). Feche o outro: a conexão volta sozinha.');
        return;
      }
      // Gravação atômica, com cópia de segurança da credencial (auth-state.ts, ADR-036).
      const { state, saveCreds } = await useDurableAuthState(this.authDir, baileys);
      if (!this.wanted || generation !== this.generation) return;
      const paired = Boolean(state.creds.me?.id);
      const logger = pino({ level: 'silent' });
      const sock = makeWASocket({
        version: this.version, logger, syncFullHistory: false, markOnlineOnConnect: false,
        // Chaves em memória na frente dos arquivos (recomendação do Baileys): menos leitura de disco.
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        // O sistema não lê conversas: não processa o histórico que o WhatsApp manda ao conectar
        // (economiza memória e CPU numa VPS pequena, sobretudo em contas com muitos grupos).
        shouldSyncHistoryMessage: () => false,
        // O envio para grupo consulta os participantes; prepareSend acabou de buscá-los. Sem
        // este cache, cada envio faria duas consultas iguais (o Baileys recomenda o cache para
        // não ser limitado pelo WhatsApp).
        cachedGroupMetadata: async jid => {
          const cached = this.groupCache.get(jid);
          return cached && Date.now() - cached.at < GROUP_CACHE_MS ? cached.metadata : undefined;
        },
      });
      console.info('[WhatsApp] Iniciando protocolo', this.version.join('.'));
      this.socket = sock;
      // Gravações de credenciais em andamento. A reconexão pedida logo após o pareamento
      // precisa esperá-las, senão reabre com credenciais ainda não salvas.
      const persistCreds = () => { this.credsSaving = this.credsSaving.then(() => saveCreds()).catch(() => { this.data.error = 'Não foi possível salvar a sessão.'; }); };
      let lastQr: string | undefined;
      const showQr = async (raw: string) => {
        if (!this.interactive) {
          // Sessão pareada, ninguém pediu QR: o WhatsApp não reconhece mais este aparelho.
          console.warn('[WhatsApp] O WhatsApp pediu novo pareamento numa reconexão automática; conexão parada.');
          this.wanted = false; ++this.generation; clearTimeout(this.timer);
          this.socket = undefined; sock.end(undefined);
          await this.credsSaving.catch(() => undefined);
          await this.lock?.release().catch(() => undefined);
          this.data = { state: 'error', error: paired
            ? 'O WhatsApp não reconhece mais este aparelho (ele foi removido no celular ou a sessão foi encerrada pelo WhatsApp). Clique em Conectar e leia o QR Code.'
            : 'Não há sessão salva deste WhatsApp. Clique em Conectar e leia o QR Code.' };
          return;
        }
        lastQr = raw;
        const qr = await QRCode.toDataURL(withAdvSecret(raw, state.creds.advSecretKey), { width: 300, margin: 2 });
        if (generation === this.generation && this.data.state !== 'connected') this.data = { state: 'qr', qr };
      };
      // Ver pairing.ts: o WhatsApp aposenta o segredo do QR depois da leitura; sem girar o
      // segredo e redesenhar o QR, o celular recusa o pareamento.
      sock.ws.on('CB:notification,type:companion_reg_refresh', (node: Parameters<typeof handleCompanionRegRefresh>[0]) => {
        if (generation !== this.generation) return;
        const outcome = handleCompanionRegRefresh(node, state.creds);
        console.info('[WhatsApp] companion_reg_refresh:', outcome);
        if (outcome !== 'rotated') return;
        persistCreds();
        if (lastQr) void showQr(lastQr).catch(() => { this.data.error = 'Falha ao atualizar o QR Code.'; });
      });
      sock.ev.on('message-receipt.update', updates => {
        const write = (async () => {
        if (generation !== this.generation || !sock.user?.id) return;
        for (const { key, receipt } of updates) {
          if (!key.fromMe || !key.id || !key.remoteJid?.endsWith('@g.us') || !receipt.userJid) continue;
          const accountJid = jidNormalizedUser(sock.user.id);
          const readAt = Number(receipt.readTimestamp);
          const deliveredAt = Number(receipt.receiptTimestamp) || readAt;
          // Recibo de entrega (ou de leitura, que implica entrega) de qualquer participante:
          // a mensagem chegou ao grupo.
          if (Number.isFinite(deliveredAt) && deliveredAt > 0) this.queueServerEvent({ kind: 'delivered', messageId: key.id, groupJid: key.remoteJid, accountJid, at: new Date(deliveredAt * 1000), ownerId: this.ownerId });
          if (!Number.isFinite(readAt) || readAt <= 0) continue;
          await persistRead(prisma, { messageId: key.id, groupJid: key.remoteJid, accountJid, participant: jidNormalizedUser(receipt.userJid), readAt: new Date(readAt * 1000), ownerId: this.ownerId });
        }
        })().catch(() => { console.error('[WhatsApp] Falha ao persistir recibo no banco; leitura pode estar incompleta.'); });
        this.receiptWrites.add(write);
        void write.finally(() => this.receiptWrites.delete(write));
      });
      // Recusa do servidor DEPOIS do sendMessage (ack com erro): o Baileys marca a mensagem
      // com status ERROR e o código. Sem ouvir isto, a entrega ficaria "enviada" para sempre.
      // @todos (ADR-039): quando o dono manda um @todos pelo celular, a mensagem chega também
      // aqui (outro aparelho da mesma conta). Guarda só o FORMATO do marcador, nunca o texto, e o
      // envio das campanhas passa a usar exatamente o mesmo marcador. Mensagens deste sistema
      // (append) e de outras pessoas não entram.
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (generation !== this.generation || type !== 'notify') return;
        for (const message of messages) {
          if (!message.key?.fromMe || !message.key.remoteJid?.endsWith('@g.us')) continue;
          const content = message.message?.extendedTextMessage ?? message.message?.imageMessage ?? message.message?.videoMessage;
          const contextInfo = content?.contextInfo;
          if (!contextInfo?.nonJidMentions) continue;
          const text = message.message?.extendedTextMessage?.text ?? message.message?.imageMessage?.caption ?? message.message?.videoMessage?.caption ?? '';
          const sample = { at: new Date().toISOString(), ...mentionAllSample(text, contextInfo) };
          console.info('[WhatsApp] Formato do @todos capturado do celular:', JSON.stringify(sample));
          this.mentionSample = sample;
          void writeAtomic(this.mentionSampleFile, JSON.stringify(sample, null, 2)).catch(() => undefined);
        }
      });
      sock.ev.on('messages.update', updates => {
        if (generation !== this.generation || !sock.user?.id) return;
        for (const { key, update } of updates) {
          if (!key.fromMe || !key.id || !key.remoteJid?.endsWith('@g.us') || update.status !== proto.WebMessageInfo.Status.ERROR) continue;
          const code = String(update.messageStubParameters?.[0] ?? 'desconhecido');
          console.warn('[WhatsApp] Mensagem recusada pelo servidor depois do envio:', key.id, 'código', code);
          this.queueServerEvent({ kind: 'rejected', messageId: key.id, groupJid: key.remoteJid, accountJid: jidNormalizedUser(sock.user.id), at: new Date(), code, ownerId: this.ownerId });
        }
      });
      sock.ev.on('creds.update', persistCreds);
      sock.ev.on('connection.update', update => {
        void (async () => {
          if (generation !== this.generation) return;
          if ('qr' in update && !update.qr) delete this.data.qr;
          if (update.qr) await showQr(update.qr);
          if (update.connection === 'open') {
            this.retries = 0;
            this.interactive = false; // conectado: dali em diante, reconexões são automáticas
            this.data = { state: 'connected', accountJid: jidNormalizedUser(sock.user?.id) };
          }
          if (update.connection === 'close') {
            this.socket = undefined;
            const error = update.lastDisconnect?.error as { message?: string; output?: { statusCode?: number } } | undefined;
            const code = error?.output?.statusCode;
            console.info('[WhatsApp] Conexão encerrada. Código:', code ?? 'indisponível', error?.message ?? '');
            const action = closeAction(code, error?.message, this.retries);
            if (action.kind === 'stop' || !this.wanted) {
              this.wanted = false;
              await this.credsSaving.catch(() => undefined);
              if (action.kind === 'stop' && action.clearSession) {
                // Espera a última gravação terminar: senão ela recriaria arquivos na pasta apagada.
                await rm(this.authDir, { recursive: true, force: true }).catch(() => {});
              }
              await this.lock?.release().catch(() => undefined);
              this.data = action.kind === 'stop' ? { state: 'error', error: action.error } : { state: 'disconnected' };
              // Número recusado pelo WhatsApp: pode ser restrição. Pausa as campanhas (ADR-041).
              if (code === CODE.forbidden && this.ownerId) void safetyPause(this.ownerId, SAFETY_REASONS.forbidden).catch(() => undefined);
              return;
            }
            this.scheduleReconnect(action.delayMs, action.countsAsRetry);
          }
        })().catch(error => {
          console.error('[WhatsApp] Falha ao tratar evento de conexão:', error instanceof Error ? error.message : error);
          this.data.error = 'Falha ao atualizar a conexão.';
        });
      });
    } catch (error) {
      // O motivo real vai para o log do servidor. Sem internet na partida (ou o WhatsApp Web fora
      // do ar), a conexão tenta de novo sozinha, espaçando, em vez de parar esperando um clique.
      console.error('[WhatsApp] Falha ao iniciar a conexão:', error instanceof Error ? error.message : error);
      // Sessão cifrada e SESSION_KEY ausente ou trocada (ADR-046): tentar de novo não resolve, e
      // nada na pasta foi tocado. Para com o motivo; a correção é devolver a chave e reiniciar.
      if (error instanceof SessionKeyError) {
        this.wanted = false;
        await this.lock?.release().catch(() => undefined);
        this.data = { state: 'error', error: error.message };
      }
      else if (this.wanted && generation === this.generation) this.scheduleReconnect(retryDelay(this.retries), true);
      else this.data = { state: 'error', error: 'Falha ao iniciar a conexão com o WhatsApp. Confira a internet e clique em Conectar.' };
    } finally { this.starting = false; }
  }
  /** Tenta de novo depois de `delayMs`. Depois de algumas tentativas, a tela explica a espera. */
  private scheduleReconnect(delayMs: number, countsAsRetry: boolean, message?: string) {
    if (countsAsRetry) this.retries++;
    const waiting = message ?? (this.retries >= 4
      ? `Sem conexão com o WhatsApp. Tentando de novo sozinho (tentativa ${this.retries}, a próxima em ${Math.round(delayMs / 1000)} s). Confira a internet deste computador.`
      : undefined);
    this.data = waiting ? { state: 'reconnecting', error: waiting } : { state: 'reconnecting' };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Espera a credencial terminar de gravar antes de reabrir (importante logo após parear).
      void this.credsSaving.catch(() => undefined).then(() => { if (this.wanted) void this.open(); });
    }, delayMs);
  }
  async disconnect() {
    this.wanted = false; ++this.generation; clearTimeout(this.timer);
    this.version = undefined;
    forgetProtocolVersion();
    const sock = this.socket; this.socket = undefined;
    this.data = { state: 'disconnected' };
    let logoutFailed = false;
    try {
      if (sock) {
        try { await sock.logout(); }
        catch { logoutFailed = true; }
        finally { sock.end(undefined); }
      }
      await this.credsSaving.catch(() => undefined);
      await rm(this.authDir, { recursive: true, force: true });
    } finally {
      await this.lock?.release().catch(() => undefined);
    }
    if (logoutFailed) {
      this.data = { state: 'error', error: 'Não foi possível revogar a sessão pelo WhatsApp. Remova este aparelho no celular.' };
      throw new Error(this.data.error);
    }
    return this.status();
  }
  private connected() {
    if (!this.socket || this.data.state !== 'connected') throw new Error('WhatsApp desconectado.');
    return this.socket;
  }
  async flushReads() {
    await flushPendingReads(prisma, { ownerId: this.ownerId, includeUnowned: this.legacySession });
  }

  // Eventos do servidor (entrega/recusa) podem chegar antes de a entrega ser gravada: ficam
  // aqui e são reaplicados a cada ciclo do despachante por até 15 minutos. Um reinício nessa
  // janela perde o evento (mesma limitação já aceita para leituras em memória).
  private serverEvents: (ServerEvent & { queuedAt: number })[] = [];
  private deliveredSeen = new Map<string, number>();
  private queueServerEvent(event: ServerEvent) {
    if (event.kind === 'delivered') {
      // Um recibo por participante: basta o primeiro de cada mensagem.
      if (this.deliveredSeen.has(event.messageId)) return;
      this.deliveredSeen.set(event.messageId, Date.now());
    }
    this.serverEvents.push({ ...event, queuedAt: Date.now() });
    void this.flushDeliveryEvents().catch(() => undefined);
  }
  async flushDeliveryEvents() {
    const now = Date.now();
    for (const [id, seenAt] of this.deliveredSeen) if (now - seenAt > 3_600_000) this.deliveredSeen.delete(id);
    const pending = this.serverEvents;
    this.serverEvents = [];
    for (const event of pending) {
      const applied = await applyServerEvent(prisma, event).catch(() => false);
      if (applied) continue;
      if (now - event.queuedAt < 15 * 60_000) this.serverEvents.push(event);
      else if (event.kind === 'rejected') console.warn('[WhatsApp] Recusa do servidor sem entrega correspondente; descartada:', event.messageId);
    }
  }
  /** Importa os grupos da conta conectada para o usuário `ownerId` (ADR-017). */
  async sync(ownerId: string) {
    const sock = this.connected();
    const groups = Object.values(await sock.groupFetchAllParticipating());
    const me = { id: sock.user?.id, lid: sock.user?.lid };
    await prisma.$transaction(async tx => {
      // Só os grupos deste dono: a sincronização de um usuário nunca desativa os de outro.
      await tx.group.updateMany({ where: { userId: ownerId, externalId: { not: null } }, data: { active: false } });
      for (const group of groups) {
        // Grupos sem assunto (antigos ou comunidades) derrubariam a sincronização inteira.
        const name = groupName(group.subject, group.id);
        const { onlyAdmins: adminOnly, isAdmin, participants } = describeGroupForSend(group, me);
        const data = { name, adminOnly, isAdmin, participants };
        await tx.group.upsert({ where: { userId_externalId: { userId: ownerId, externalId: group.id } }, update: { ...data, active: true }, create: { userId: ownerId, externalId: group.id, ...data } });
      }
    }, { timeout: 30000 });
    return { count: groups.length };
  }
  async send(groupJid: string, text: string, accountJid: string | null, media?: { kind: string; mimeType: string; data: Uint8Array } | null, groupId?: string, options: { mentionAll?: boolean } = {}) {
    // Tudo até o sendMessage: uma falha aqui garante que nada saiu (reenvio permitido, ADR-014).
    const { sock, content, group } = await this.prepareSend(groupJid, text, accountJid, media, groupId, options).catch(error => { throw notSent(error); });
    // Daqui em diante o resultado pode ser incerto: nunca é reenviado automaticamente.
    // Sem mediaUploadTimeoutMs o Baileys sobe a mídia SEM limite de tempo: um upload pendurado
    // (comum logo após uma reconexão) segurava o envio para sempre e travava a fila do número.
    const result = await sock.sendMessage(groupJid, content, { mediaUploadTimeoutMs: MEDIA_UPLOAD_TIMEOUT_MS });
    if (!result?.key.id) throw new Error('Resultado do envio desconhecido. Confira no celular antes de reenviar.');
    // O id só confirma que o pedido foi escrito no socket; entrega ou recusa chegam depois.
    return { messageId: result.key.id, context: group.context };
  }
  private async prepareSend(groupJid: string, text: string, accountJid: string | null, media?: { kind: string; mimeType: string; data: Uint8Array } | null, groupId?: string, options: { mentionAll?: boolean } = {}) {
    const sock = this.connected();
    if (accountJid !== this.data.accountJid) throw new Error('Número conectado difere do número da campanha.');
    if (!groupJid.endsWith('@g.us')) throw new Error('Destino não é um grupo.');
    // Registra a situação do grupo (membro, admin, só admins enviam) para explicar uma
    // eventual recusa do servidor.
    const metadata = await sock.groupMetadata(groupJid);
    for (const [jid, entry] of this.groupCache) if (Date.now() - entry.at > GROUP_CACHE_MS) this.groupCache.delete(jid);
    this.groupCache.set(groupJid, { metadata, at: Date.now() });
    const me = { id: sock.user?.id, lid: sock.user?.lid };
    const group = describeGroupForSend(metadata, me);
    // Mantém selo (só admins / você é admin) e membros atualizados. Atinge SOMENTE o grupo
    // desta entrega (ADR-022): dois usuários podem ter o mesmo grupo, com situações diferentes.
    const alvo = groupId ? { id: groupId } : { externalId: groupJid, ...(this.ownerId ? { userId: this.ownerId } : {}) };
    await prisma.group.updateMany({ where: alvo, data: { adminOnly: group.onlyAdmins, isAdmin: group.isAdmin, participants: group.participants } }).catch(() => undefined);
    // Grupo só para administradores e a conta comprovadamente não é admin: o WhatsApp
    // aceita o pedido mas a mensagem nunca aparece (teste real, 2026-09-21).
    if (group.adminOnlyWithoutPermission) {
      throw Object.assign(new Error('Só administradores podem enviar neste grupo e a conta conectada não é administradora.'), { code: 'grupo:so-admins' });
    }
    if (this.socket !== sock || this.data.state !== 'connected') throw new Error('Conexão interrompida antes do envio.');
    if (media && !['image', 'video'].includes(media.kind)) throw Error('Tipo de mídia inválido.');
    // "Marcar todos": o @todos nativo do WhatsApp quando a regra dele permite (grupo de até 32
    // membros, ou a conta é admin — ADR-039); senão, a marcação oculta de cada membro (ADR-029),
    // que também notifica. Igual em texto, imagem e vídeo (vai junto da legenda).
    const mode = options.mentionAll ? mentionAllMode(group) : null;
    const mentions = mode === 'hidden' ? mentionTargets(metadata, me) : [];
    const body = mode === 'native' ? withMentionAllToken(text, await this.mentionAllToken()) : text;
    const tag = mode === 'native' ? { contextInfo: { nonJidMentions: 1 } } : mentions.length ? { mentions } : {};
    const content = !media ? { text: body, ...tag } : media.kind === 'image'
      ? { image: Buffer.from(media.data), mimetype: media.mimeType, caption: body, ...tag }
      : { video: Buffer.from(media.data), mimetype: media.mimeType, caption: body, ...tag };
    const marked = mode === 'native' ? 'mencoes=todos' : mode === 'hidden' ? `mencoes=${mentions.length}` : '';
    const context = marked ? `${group.context} ${marked}`.slice(0, 160) : group.context;
    return { sock, content, group: { ...group, context } };
  }
  /** Arquivo com o formato do @todos capturado do celular (ao lado da pasta da sessão). */
  private get mentionSampleFile() { return path.join(path.dirname(this.authDir), 'mencao-todos.json'); }
  private mentionSample?: { tokens: string[]; nonJidMentions: number | null };
  /**
   * Marcador do @todos: o que o celular do dono usou num @todos de verdade (captura), senão o
   * padrão. Só aceita palavra sem número, para um "@5511…" nunca virar marcador.
   */
  private async mentionAllToken() {
    if (!this.mentionSample) {
      try { this.mentionSample = JSON.parse(await readFile(this.mentionSampleFile, 'utf8')); }
      catch { /* sem captura ainda: usa o padrão */ }
    }
    const tokens = (this.mentionSample?.tokens ?? []).filter(token => /^@[\p{L}_]+$/u.test(token));
    const known = tokens.find(token => /^@(todos|all|everyone)$/i.test(token));
    return known ?? (tokens.length === 1 ? tokens[0] : DEFAULT_MENTION_ALL_TOKEN);
  }
  /**
   * Renova a conexão sem logout e sem QR: encerra o socket atual e o fluxo normal de queda
   * reconecta com a mesma sessão. Usado quando um envio não teve resposta (socket emperrado).
   */
  recycle(reason: string) {
    if (!this.socket || !this.wanted) return;
    console.warn('[WhatsApp] Renovando a conexão:', reason);
    this.socket.end(new Error(reason));
  }
  async stop() {
    this.wanted = false; ++this.generation; clearTimeout(this.timer); this.socket?.end(undefined);
    // Termina de gravar a credencial antes de sair: encerrar no meio corrompia o creds.json.
    await this.credsSaving.catch(() => undefined);
    // Encerrada sem logout: a autenticação fica, mas a conexão não está mais de pé.
    this.socket = undefined;
    this.data = { state: 'disconnected' };
    await Promise.all(this.receiptWrites);
    await this.lock?.release().catch(() => undefined);
  }
}
