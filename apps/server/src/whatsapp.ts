import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { prisma, persistRead, flushPendingReads, applyServerEvent, type ServerEvent } from '@campaign/database';
import { describeGroupForSend, notSent } from './send-context';
import QRCode from 'qrcode';
import { handleCompanionRegRefresh, withAdvSecret } from './pairing';
import { closeAction } from './connection-policy';
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
export function defaultSessionsDir() {
  if (process.env.SESSIONS_DIR) return path.resolve(process.env.SESSIONS_DIR);
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'raf-campanhas', 'sessions');
  }
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'raf-campanhas', 'sessions');
}

export class WhatsAppProvider {
  private socket?: WASocket;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private retries = 0;
  private wanted = false;
  private starting = false;
  private version?: WAVersion;
  private receiptWrites = new Set<Promise<void>>();
  private credsSaving: Promise<void> = Promise.resolve();
  private authDir: string;
  private data: { state: string; qr?: string; accountJid?: string; error?: string } = { state: 'disconnected' };
  constructor(authDir = defaultSessionsDir()) {
    this.authDir = path.join(authDir, 'whatsapp');
  }
  status() { return { ...this.data }; }
  /** Há uma sessão já pareada salva? Reconectar com ela não exige ler QR. */
  async hasPairedSession() {
    try {
      const creds = JSON.parse(await readFile(path.join(this.authDir, 'creds.json'), 'utf8')) as { me?: { id?: string } };
      return Boolean(creds.me?.id);
    } catch { return false; }
  }
  async connect() {
    if (this.starting || ['connected', 'connecting', 'qr', 'reconnecting'].includes(this.data.state)) return this.status();
    this.wanted = true; this.retries = 0;
    await this.open();
    return this.status();
  }
  private async open() {
    this.starting = true;
    const generation = ++this.generation;
    this.data = { state: 'connecting' };
    try {
      const { default: makeWASocket, useMultiFileAuthState, jidNormalizedUser, fetchLatestWaWebVersion, proto } = await import('@whiskeysockets/baileys');
      const { default: pino } = await import('pino');
      // Keep the verified version across reconnects; never silently downgrade.
      this.version ??= await resolveWebVersion(() => fetchLatestWaWebVersion({ signal: AbortSignal.timeout(15000) }));
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      if (!this.wanted || generation !== this.generation) return;
      const sock = makeWASocket({ version: this.version, auth: state, logger: pino({ level: 'silent' }), syncFullHistory: false, markOnlineOnConnect: false });
      console.info('[WhatsApp] Iniciando protocolo', this.version.join('.'));
      this.socket = sock;
      // Gravações de credenciais em andamento. A reconexão pedida logo após o pareamento
      // precisa esperá-las, senão reabre com credenciais ainda não salvas.
      const persistCreds = () => { this.credsSaving = this.credsSaving.then(() => saveCreds()).catch(() => { this.data.error = 'Não foi possível salvar a sessão.'; }); };
      let lastQr: string | undefined;
      const showQr = async (raw: string) => {
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
          if (Number.isFinite(deliveredAt) && deliveredAt > 0) this.queueServerEvent({ kind: 'delivered', messageId: key.id, groupJid: key.remoteJid, accountJid, at: new Date(deliveredAt * 1000) });
          if (!Number.isFinite(readAt) || readAt <= 0) continue;
          await persistRead(prisma, { messageId: key.id, groupJid: key.remoteJid, accountJid, participant: jidNormalizedUser(receipt.userJid), readAt: new Date(readAt * 1000) });
        }
        })().catch(() => { console.error('[WhatsApp] Falha ao persistir recibo no banco; leitura pode estar incompleta.'); });
        this.receiptWrites.add(write);
        void write.finally(() => this.receiptWrites.delete(write));
      });
      // Recusa do servidor DEPOIS do sendMessage (ack com erro): o Baileys marca a mensagem
      // com status ERROR e o código. Sem ouvir isto, a entrega ficaria "enviada" para sempre.
      sock.ev.on('messages.update', updates => {
        if (generation !== this.generation || !sock.user?.id) return;
        for (const { key, update } of updates) {
          if (!key.fromMe || !key.id || !key.remoteJid?.endsWith('@g.us') || update.status !== proto.WebMessageInfo.Status.ERROR) continue;
          const code = String(update.messageStubParameters?.[0] ?? 'desconhecido');
          console.warn('[WhatsApp] Mensagem recusada pelo servidor depois do envio:', key.id, 'código', code);
          this.queueServerEvent({ kind: 'rejected', messageId: key.id, groupJid: key.remoteJid, accountJid: jidNormalizedUser(sock.user.id), at: new Date(), code });
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
              if (action.kind === 'stop' && action.clearSession) await rm(this.authDir, { recursive: true, force: true }).catch(() => {});
              this.data = action.kind === 'stop' ? { state: 'error', error: action.error } : { state: 'disconnected' };
              return;
            }
            if (action.countsAsRetry) this.retries++;
            this.data = { state: 'reconnecting' };
            await this.credsSaving;
            this.timer = setTimeout(() => { void this.open(); }, action.delayMs);
          }
        })().catch(error => {
          console.error('[WhatsApp] Falha ao tratar evento de conexão:', error instanceof Error ? error.message : error);
          this.data.error = 'Falha ao atualizar a conexão.';
        });
      });
    } catch (error) {
      // O motivo real vai para o log do servidor; a tela recebe uma mensagem acionável.
      console.error('[WhatsApp] Falha ao iniciar a conexão:', error instanceof Error ? error.message : error);
      this.data = { state: 'error', error: this.version ? 'Falha ao iniciar a conexão com o WhatsApp. Confira a internet deste computador e clique em Conectar.' : 'Não foi possível consultar a versão atual do WhatsApp Web. Confira a internet e clique em Conectar.' };
    } finally { this.starting = false; }
  }
  async disconnect() {
    this.wanted = false; ++this.generation; clearTimeout(this.timer);
    this.version = undefined;
    const sock = this.socket; this.socket = undefined;
    this.data = { state: 'disconnected' };
    let logoutFailed = false;
    if (sock) {
      try { await sock.logout(); }
      catch { logoutFailed = true; }
      finally { sock.end(undefined); }
    }
    await rm(this.authDir, { recursive: true, force: true });
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
    await flushPendingReads(prisma);
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
  async sync() {
    const sock = this.connected();
    const groups = Object.values(await sock.groupFetchAllParticipating());
    const me = { id: sock.user?.id, lid: sock.user?.lid };
    await prisma.$transaction(async tx => {
      await tx.group.updateMany({ where: { externalId: { not: null } }, data: { active: false } });
      for (const group of groups) {
        // Grupos sem assunto (antigos ou comunidades) derrubariam a sincronização inteira.
        const name = groupName(group.subject, group.id);
        const { onlyAdmins: adminOnly, isAdmin, participants } = describeGroupForSend(group, me);
        const data = { name, adminOnly, isAdmin, participants };
        await tx.group.upsert({ where: { externalId: group.id }, update: { ...data, active: true }, create: { externalId: group.id, ...data } });
      }
    }, { timeout: 30000 });
    return { count: groups.length };
  }
  async send(groupJid: string, text: string, accountJid: string | null, media?: { kind: string; mimeType: string; data: Uint8Array } | null) {
    // Tudo até o sendMessage: uma falha aqui garante que nada saiu (reenvio permitido, ADR-014).
    const { sock, content, group } = await this.prepareSend(groupJid, text, accountJid, media).catch(error => { throw notSent(error); });
    // Daqui em diante o resultado pode ser incerto: nunca é reenviado automaticamente.
    const result = await sock.sendMessage(groupJid, content);
    if (!result?.key.id) throw new Error('Resultado do envio desconhecido. Confira no celular antes de reenviar.');
    // O id só confirma que o pedido foi escrito no socket; entrega ou recusa chegam depois.
    return { messageId: result.key.id, context: group.context };
  }
  private async prepareSend(groupJid: string, text: string, accountJid: string | null, media?: { kind: string; mimeType: string; data: Uint8Array } | null) {
    const sock = this.connected();
    if (accountJid !== this.data.accountJid) throw new Error('Número conectado difere do número da campanha.');
    if (!groupJid.endsWith('@g.us')) throw new Error('Destino não é um grupo.');
    // Registra a situação do grupo (membro, admin, só admins enviam) para explicar uma
    // eventual recusa do servidor.
    const group = describeGroupForSend(await sock.groupMetadata(groupJid), { id: sock.user?.id, lid: sock.user?.lid });
    // Mantém selo (só admins / você é admin) e membros atualizados; falha aqui não impede o envio.
    await prisma.group.updateMany({ where: { externalId: groupJid }, data: { adminOnly: group.onlyAdmins, isAdmin: group.isAdmin, participants: group.participants } }).catch(() => undefined);
    // Grupo só para administradores e a conta comprovadamente não é admin: o WhatsApp
    // aceita o pedido mas a mensagem nunca aparece (teste real, 2026-09-21).
    if (group.adminOnlyWithoutPermission) {
      throw Object.assign(new Error('Só administradores podem enviar neste grupo e a conta conectada não é administradora.'), { code: 'grupo:so-admins' });
    }
    if (this.socket !== sock || this.data.state !== 'connected') throw new Error('Conexão interrompida antes do envio.');
    if (media && !['image', 'video'].includes(media.kind)) throw Error('Tipo de mídia inválido.');
    const content = !media ? { text } : media.kind === 'image'
      ? { image: Buffer.from(media.data), mimetype: media.mimeType, caption: text }
      : { video: Buffer.from(media.data), mimetype: media.mimeType, caption: text };
    return { sock, content, group };
  }
  async stop() {
    this.wanted = false; ++this.generation; clearTimeout(this.timer); this.socket?.end(undefined);
    await Promise.all(this.receiptWrites);
  }
}
