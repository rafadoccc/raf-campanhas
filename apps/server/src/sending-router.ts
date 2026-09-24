import { legacySessionOwnerId, type LegacyBridgeDeps } from './legacy-session';
import type { SendingProvider } from './dispatcher';

// Quem envia por quem (ADR-022, Fase 4D).
//
//   Delivery → Campaign.userId → conexão DAQUELE usuário → número dele → envio.
//
// Nunca existe "qualquer WhatsApp disponível": sem conexão do próprio dono, o envio espera.
// A única exceção é a sessão global legada, e só para o dono comprovado dela (ponte da 4C,
// centralizada em legacy-session.ts). Ela sai de cena na 4E.

/** Mínimo que o roteador precisa enxergar de uma conexão. */
type Connection = { status(): { state: string; accountJid?: string } };

export type SendingEntry<P extends Connection = SendingProvider> = { ownerId: string; provider: P };

export type SendingRouter<P extends Connection = SendingProvider> = {
  /** Conexão do dono da campanha, ou null se ele não tem nenhuma utilizável. */
  forOwner(userId: string): Promise<P | null>;
  /** Conexões vivas com dono conhecido, para aplicar recibos e eventos de cada uma. */
  entries(): Promise<SendingEntry<P>[]>;
};

type Options<P extends Connection> = {
  manager: { peek(userId: string): P | undefined; owners(): string[]; sessionDirFor(userId: string): string };
  legacyProvider: P & { hasPairedSession(): Promise<boolean> };
  bridge?: Partial<Pick<LegacyBridgeDeps, 'db' | 'env'>>;
};

export function createSendingRouter<P extends Connection>({ manager, legacyProvider, bridge }: Options<P>): SendingRouter<P> {
  const deps = (): LegacyBridgeDeps => ({ legacyProvider, ownSessionDir: (userId: string) => manager.sessionDirFor(userId), ...bridge });
  return {
    async forOwner(userId) {
      // 1) A conexão do próprio usuário, se existir. Nunca cria uma vazia só para enviar.
      const own = manager.peek(userId);
      if (own) return own;
      // 2) Só o dono comprovado da sessão legada pode usá-la (some na 4E).
      return await legacySessionOwnerId(deps()) === userId ? legacyProvider : null;
    },
    async entries() {
      const list: SendingEntry<P>[] = [];
      for (const ownerId of manager.owners()) {
        const provider = manager.peek(ownerId);
        if (provider) list.push({ ownerId, provider });
      }
      const legacyOwner = await legacySessionOwnerId(deps());
      if (legacyOwner && !list.some(entry => entry.ownerId === legacyOwner)) list.push({ ownerId: legacyOwner, provider: legacyProvider });
      return list;
    },
  };
}

/** Roteador fixo (testes e cenários de uma conexão só). */
export function staticRouter(entries: SendingEntry[]): SendingRouter {
  return {
    async forOwner(userId) { return entries.find(entry => entry.ownerId === userId)?.provider ?? null; },
    async entries() { return entries; },
  };
}
