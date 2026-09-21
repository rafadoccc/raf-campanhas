import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { prisma, persistRead, flushPendingReads } from '@campaign/database';
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
      const { default: makeWASocket, useMultiFileAuthState, jidNormalizedUser, fetchLatestWaWebVersion } = await import('@whiskeysockets/baileys');
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
          const timestamp = Number(receipt.readTimestamp);
          if (!key.fromMe || !key.id || !key.remoteJid?.endsWith('@g.us') || !receipt.userJid || !Number.isFinite(timestamp) || timestamp <= 0) continue;
          await persistRead(prisma, { messageId: key.id, groupJid: key.remoteJid, accountJid: jidNormalizedUser(sock.user.id), participant: jidNormalizedUser(receipt.userJid), readAt: new Date(timestamp * 1000) });
        }
        })().catch(() => { console.error('[WhatsApp] Falha ao persistir recibo no banco; leitura pode estar incompleta.'); });
        this.receiptWrites.add(write);
        void write.finally(() => this.receiptWrites.delete(write));
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
  async sync() {
    const sock = this.connected();
    const groups = Object.values(await sock.groupFetchAllParticipating());
    await prisma.$transaction(async tx => {
      await tx.group.updateMany({ where: { externalId: { not: null } }, data: { active: false } });
      for (const group of groups) {
        // Grupos sem assunto (antigos ou comunidades) derrubariam a sincronização inteira.
        const name = groupName(group.subject, group.id);
        await tx.group.upsert({ where: { externalId: group.id }, update: { name, active: true }, create: { externalId: group.id, name } });
      }
    }, { timeout: 30000 });
    return { count: groups.length };
  }
  async send(groupJid: string, text: string, accountJid: string | null, media?: { kind: string; mimeType: string; data: Uint8Array } | null) {
    const sock = this.connected();
    if (accountJid !== this.data.accountJid) throw new Error('Número conectado difere do número da campanha.');
    if (!groupJid.endsWith('@g.us')) throw new Error('Destino não é um grupo.');
    // Metadata checks membership and server permissions; sendMessage also enforces restrictions.
    await sock.groupMetadata(groupJid);
    if (this.socket !== sock || this.data.state !== 'connected') throw new Error('Conexão interrompida antes do envio.');
    if (media && !['image', 'video'].includes(media.kind)) throw Error('Tipo de mídia inválido.');
    const content = !media ? { text } : media.kind === 'image'
      ? { image: Buffer.from(media.data), mimetype: media.mimeType, caption: text }
      : { video: Buffer.from(media.data), mimetype: media.mimeType, caption: text };
    const result = await sock.sendMessage(groupJid, content);
    if (!result?.key.id) throw new Error('Resultado do envio desconhecido. Confira no celular antes de reenviar.');
    return result.key.id;
  }
  async stop() {
    this.wanted = false; ++this.generation; clearTimeout(this.timer); this.socket?.end(undefined);
    await Promise.all(this.receiptWrites);
  }
}
