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

export type StartOutcome = { userId: string; outcome: 'conectando' | 'sem-sessao' | 'falhou'; error?: string };

type Options = {
  db?: typeof prisma;
  /** Raiz das sessões; nos testes, uma pasta temporária. */
  sessionsBase?: string;
  createProvider?: (ownerId: string, sessionDir: string) => ManagedProvider;
};

export class WhatsAppManager {
  private providers = new Map<string, ManagedProvider>();
  private readonly db: typeof prisma;
  private readonly sessionsBase?: string;
  private readonly createProvider: (ownerId: string, sessionDir: string) => ManagedProvider;

  constructor(options: Options = {}) {
    this.db = options.db ?? prisma;
    this.sessionsBase = options.sessionsBase;
    this.createProvider = options.createProvider ?? ((ownerId, sessionDir) => new WhatsAppProvider({ ownerId, sessionDir }));
  }

  /** Provider do usuário, criando na primeira vez. Sempre a mesma instância para o mesmo id. */
  for(userId: string): ManagedProvider {
    const existing = this.providers.get(userId);
    if (existing) return existing;
    // whatsappSessionDir valida o id e garante que o caminho fica dentro da pasta de sessões.
    const provider = this.createProvider(userId, whatsappSessionDir(userId, this.sessionsBase));
    this.providers.set(userId, provider);
    return provider;
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
  async persistState(userId: string) {
    const status = this.providers.get(userId)?.status() ?? { state: 'disconnected' as const };
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
      await this.db.whatsAppSession.updateMany({ where: { userId }, data: { state: status.state.slice(0, 20), lastError: 'Este número já está conectado em outra conta.' } });
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
        await provider.connect();
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
