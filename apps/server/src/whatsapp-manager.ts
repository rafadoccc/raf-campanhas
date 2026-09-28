import { prisma } from '@campaign/database';
import { WhatsAppProvider } from './whatsapp';
import { whatsappSessionDir } from './session-paths';

// Uma conexão de WhatsApp por usuário (ADR-020, Fase 4B).
//
//   userId A → provider A → SESSIONS_DIR/users/A/whatsapp
//   userId B → provider B → SESSIONS_DIR/users/B/whatsapp
//
// O gerenciador só monta caminhos por whatsappSessionDir(userId), então nunca alcança a sessão
// global legada (SESSIONS_DIR/whatsapp), que continua sendo o caminho de produção de hoje.
// Nada é compartilhado entre providers: socket, credenciais, QR, estado, timers e eventos são
// de cada instância. O banco guarda só o ciclo de vida (nunca QR nem credenciais).

/** O que o gerenciador usa de um provider. Permite injetar um duble nos testes. */
export type ManagedProvider = Pick<WhatsAppProvider, 'ownerId' | 'sessionDir' | 'status' | 'connect' | 'disconnect' | 'stop' | 'hasPairedSession' | 'sync' | 'send' | 'flushReads' | 'flushDeliveryEvents'>;

/** Última sincronização de grupos de um usuário (mostrada na tela do WhatsApp). */
export type GroupsSync = { running: boolean; auto: boolean; at: Date | null; count: number | null; error: string | null };

// Sincronizar de novo antes disso é recusado com aviso (limite suave do botão).
export const SYNC_COOLDOWN_MS = 30_000;
// Ao conectar, sincroniza sozinho, a não ser que já tenha sincronizado há pouco (ex.: a conexão
// caiu e voltou em seguida).
const AUTO_SYNC_FRESH_MS = 10 * 60_000;
// Espera a conexão assentar antes de pedir a lista de grupos.
const AUTO_SYNC_DELAY_MS = 3_000;

export class SyncTooSoonError extends Error {}

export type StartOutcome = { userId: string; outcome: 'conectando' | 'sem-sessao' | 'falhou'; error?: string };

type Options = {
  db?: typeof prisma;
  /** Raiz das sessões; nos testes, uma pasta temporária. */
  sessionsBase?: string;
  /** onStateChange: chamar a cada troca de estado da conexão (o gerenciador grava no banco). */
  createProvider?: (ownerId: string, sessionDir: string, onStateChange: () => void) => ManagedProvider;
  /** Espera antes da sincronização automática ao conectar (nos testes, 0). */
  autoSyncDelayMs?: number;
};

export class WhatsAppManager {
  private providers = new Map<string, ManagedProvider>();
  private readonly db: typeof prisma;
  private readonly sessionsBase?: string;
  private readonly createProvider: (ownerId: string, sessionDir: string, onStateChange: () => void) => ManagedProvider;
  /** Gravações de estado em fila, uma por vez por usuário (a última sempre vence). */
  private persisting = new Map<string, Promise<void>>();
  private syncs = new Map<string, GroupsSync & { promise?: Promise<{ count: number }> }>();
  private lastState = new Map<string, string>();
  private readonly autoSyncDelayMs: number;

  constructor(options: Options = {}) {
    this.db = options.db ?? prisma;
    this.sessionsBase = options.sessionsBase;
    this.autoSyncDelayMs = options.autoSyncDelayMs ?? AUTO_SYNC_DELAY_MS;
    this.createProvider = options.createProvider ?? ((ownerId, sessionDir, onStateChange) => new WhatsAppProvider({ ownerId, sessionDir, onStateChange }));
  }

  /** Provider do usuário, criando na primeira vez. Sempre a mesma instância para o mesmo id. */
  for(userId: string): ManagedProvider {
    const existing = this.providers.get(userId);
    if (existing) return existing;
    // whatsappSessionDir valida o id e garante que o caminho fica dentro da pasta de sessões.
    const provider = this.createProvider(userId, whatsappSessionDir(userId, this.sessionsBase), () => {
      void this.queuePersist(userId);
      this.autoSyncOnConnect(userId);
    });
    this.providers.set(userId, provider);
    return provider;
  }

  /** Situação da sincronização de grupos do usuário (sem a promessa interna). */
  syncInfo(userId: string): GroupsSync | null {
    const entry = this.syncs.get(userId);
    if (!entry) return null;
    const { promise: _promise, ...info } = entry;
    return info;
  }

  /**
   * Sincroniza os grupos do usuário. Pedido repetido enquanto uma sincronização roda recebe a
   * mesma; pedido manual até 30 s depois da última é recusado (SyncTooSoonError).
   */
  async syncGroups(userId: string, auto = false): Promise<{ count: number }> {
    const current = this.syncs.get(userId);
    if (current?.promise) return current.promise;
    if (!auto && current?.at && !current.error && Date.now() - current.at.getTime() < SYNC_COOLDOWN_MS) {
      const wait = Math.ceil((SYNC_COOLDOWN_MS - (Date.now() - current.at.getTime())) / 1000);
      throw new SyncTooSoonError(`Os grupos acabaram de ser sincronizados. Aguarde ${wait} s para sincronizar de novo.`);
    }
    const provider = this.for(userId);
    const promise = provider.sync(userId);
    this.syncs.set(userId, { running: true, auto, at: current?.at ?? null, count: current?.count ?? null, error: null, promise });
    try {
      const result = await promise;
      this.syncs.set(userId, { running: false, auto, at: new Date(), count: result.count, error: null });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao sincronizar os grupos.';
      this.syncs.set(userId, { running: false, auto, at: new Date(), count: current?.count ?? null, error: message.slice(0, 200) });
      throw error;
    }
  }

  /** Conectou (e antes não estava): sincroniza os grupos sozinho, sem esperar o clique. */
  private autoSyncOnConnect(userId: string) {
    const provider = this.providers.get(userId);
    const state = provider?.status().state ?? 'disconnected';
    const before = this.lastState.get(userId);
    this.lastState.set(userId, state);
    if (state !== 'connected' || before === 'connected') return;
    const last = this.syncs.get(userId);
    if (last?.running || (last?.at && !last.error && Date.now() - last.at.getTime() < AUTO_SYNC_FRESH_MS)) return;
    setTimeout(() => {
      if (this.providers.get(userId)?.status().state !== 'connected') return;
      this.syncGroups(userId, true).catch(error => {
        console.warn('[WhatsApp] Sincronização automática de grupos falhou para', userId, error instanceof Error ? error.message : error);
      });
    }, this.autoSyncDelayMs).unref();
  }

  /** Caminho da sessão que este usuário teria, sem criar provider nem pasta. */
  sessionDirFor(userId: string) { return whatsappSessionDir(userId, this.sessionsBase); }

  /** Consulta sem criar: usado por quem só quer saber se há conexão ativa. */
  peek(userId: string) { return this.providers.get(userId); }

  /** Ids com provider em memória (diagnóstico e testes). */
  owners() { return [...this.providers.keys()]; }

  /** Garante a linha de ciclo de vida do usuário (sem tocar em arquivos de sessão). */
  async ensureSession(userId: string) {
    return this.db.whatsAppSession.upsert({ where: { userId }, update: {}, create: { userId } });
  }

  /**
   * Encerra a conexão do usuário PRESERVANDO a autenticação: não faz logout, não apaga a pasta.
   * É o que acontece ao desligar o sistema ou ao desativar um usuário.
   */
  async stop(userId: string) {
    const provider = this.providers.get(userId);
    if (!provider) return;
    this.providers.delete(userId);
    await provider.stop();
  }

  async stopAll() {
    await Promise.all(this.owners().map(userId => this.stop(userId).catch(error => {
      console.error('[WhatsApp] Falha ao encerrar a conexão de', userId, error instanceof Error ? error.message : error);
    })));
  }

  /**
   * Desconectar de verdade, a pedido do usuário: faz logout e remove a autenticação DELE
   * (a pasta do próprio usuário). Nunca toca na sessão de outro nem na legada.
   */
  async disconnect(userId: string) {
    const provider = this.for(userId);
    try {
      return await provider.disconnect();
    } finally {
      this.providers.delete(userId);
      await this.db.whatsAppSession.updateMany({ where: { userId }, data: { state: 'disconnected', accountJid: null, lastError: null } })
        .catch(() => undefined);
    }
  }

  /**
   * Copia para o banco o estado atual da conexão (exibição e partida). Nunca grava QR nem
   * credenciais: só estado, número pareado, último acesso e último erro.
   */
  /**
   * Grava o estado depois de cada troca (conectou, caiu, reconectando…). Antes só era gravado no
   * pedido de conectar: o banco ficava em "connecting" sem número para sempre e a trava de
   * número único nunca era conferida.
   */
  queuePersist(userId: string) {
    const previous = this.persisting.get(userId) ?? Promise.resolve();
    const next = previous.then(() => this.persistState(userId)).catch(error => {
      console.error('[WhatsApp] Não foi possível gravar o estado da conexão de', userId, error instanceof Error ? error.message : error);
    });
    this.persisting.set(userId, next);
    void next.finally(() => { if (this.persisting.get(userId) === next) this.persisting.delete(userId); });
    return next;
  }

  async persistState(userId: string) {
    const provider = this.providers.get(userId);
    if (!provider) {
      // Conexão encerrada (stop): só marca desconectado, sem apagar um erro já registrado —
      // ex.: o aviso de número de outra conta, gravado logo antes deste encerramento.
      await this.db.whatsAppSession.updateMany({ where: { userId, state: { not: 'error' } }, data: { state: 'disconnected' } });
      return;
    }
    const status = provider.status();
    const connected = status.state === 'connected';
    const data = {
      state: status.state.slice(0, 20),
      lastError: status.error?.slice(0, 255) ?? null,
      ...(connected ? { accountJid: status.accountJid ?? null, lastConnectedAt: new Date() } : {}),
    };
    try {
      await this.db.whatsAppSession.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    } catch (error) {
      // Número já pareado em outro usuário (accountJid é único): registra e segue.
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') throw error;
      // Um número pertence a uma única conta (ADR-019): a conexão duplicada é encerrada, sem
      // logout (não mexe no aparelho de ninguém), e a conta fica com o aviso.
      await this.db.whatsAppSession.updateMany({ where: { userId }, data: { state: 'error', lastError: 'Este número já está conectado em outra conta.' } });
      console.warn('[WhatsApp] Número já pertence a outra conta; conexão de', userId, 'encerrada.');
      const duplicate = this.providers.get(userId);
      if (duplicate) { this.providers.delete(userId); await duplicate.stop().catch(() => undefined); }
    }
  }

  /**
   * Partida: reconecta as conexões elegíveis, cada uma por conta própria. Só usuário ativo, só
   * com autoConnect e só quem já tem sessão pareada — nunca gera QR sozinho. A falha de um
   * usuário não impede os outros.
   */
  async startAll(env: NodeJS.ProcessEnv = process.env): Promise<StartOutcome[]> {
    if (env.WHATSAPP_AUTO_CONNECT === '0') return [];
    const rows = await this.db.whatsAppSession.findMany({
      where: { autoConnect: true, user: { disabledAt: null } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map(async ({ userId }): Promise<StartOutcome> => {
      try {
        const provider = this.for(userId);
        if (!await provider.hasPairedSession()) return { userId, outcome: 'sem-sessao' };
        // Partida: ninguém está olhando a tela. Se o WhatsApp pedir QR, a conexão para com o motivo.
        await provider.connect({ interactive: false });
        await this.persistState(userId);
        return { userId, outcome: 'conectando' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Falha ao reconectar.';
        console.error('[WhatsApp] Não foi possível reconectar a conexão de', userId, message);
        await this.db.whatsAppSession.updateMany({ where: { userId }, data: { state: 'error', lastError: message.slice(0, 255) } }).catch(() => undefined);
        return { userId, outcome: 'falhou', error: message };
      }
    }));
  }
}
