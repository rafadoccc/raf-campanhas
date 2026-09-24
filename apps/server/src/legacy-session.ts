import { existsSync } from 'node:fs';
import { prisma } from '@campaign/database';
import type { SessionUser } from './auth';

// Ponte TEMPORÁRIA da sessão global legada (ADR-021/022, Fases 4C e 4D).
//
// A sessão que roda em produção hoje vive em SESSIONS_DIR/whatsapp e ainda não pertence a
// ninguém no banco: a migração é a 4E. Até lá, o dono comprovado dela continua usando-a — nas
// rotas do WhatsApp e no envio das campanhas DELE. Mais ninguém a alcança.
//
// ESTA É A ÚNICA REGRA DE COMPATIBILIDADE DO PROJETO. Quem precisar decidir "esta sessão é de
// alguém?" chama `legacySessionOwnerId`; ninguém implementa um atalho próprio.
//
// O dono só é reconhecido quando TODAS as condições valem, conferidas a cada consulta:
//   1. a pasta legada tem uma sessão pareada de verdade;
//   2. o dono é inequívoco: existe exatamente UM SUPER_ADMIN ativo, ou LEGACY_SESSION_OWNER
//      aponta para um SUPER_ADMIN ativo;
//   3. esse usuário ainda NÃO tem pasta própria de sessão.
// Na 4E a condição 3 deixa de valer, a ponte se desliga sozinha e este arquivo pode sumir.

export type LegacyBridgeDeps = {
  /** Provider global legado (o mesmo que o sistema usa hoje). */
  legacyProvider: { hasPairedSession(): Promise<boolean> };
  /** Onde ficaria a pasta própria deste usuário (WhatsAppManager.sessionDirFor). */
  ownSessionDir(userId: string): string;
  db?: typeof prisma;
  env?: NodeJS.ProcessEnv;
};

/** Id do dono comprovado da sessão global legada, ou null quando não há dono inequívoco. */
export async function legacySessionOwnerId(deps: LegacyBridgeDeps): Promise<string | null> {
  const db = deps.db ?? prisma;
  const env = deps.env ?? process.env;
  if (!await deps.legacyProvider.hasPairedSession()) return null;

  const declared = env.LEGACY_SESSION_OWNER?.trim();
  const candidate = declared
    ? await db.user.findFirst({ where: { id: declared, role: 'SUPER_ADMIN', disabledAt: null }, select: { id: true } })
    : await (async () => {
      // Sem declaração explícita, só quando não há dúvida: um único SUPER_ADMIN ativo.
      const admins = await db.user.findMany({ where: { role: 'SUPER_ADMIN', disabledAt: null }, select: { id: true }, take: 2 });
      return admins.length === 1 ? admins[0] : null;
    })();
  if (!candidate) return null;

  // Já tem pasta própria (migrado na 4E): a ponte não vale mais.
  try {
    if (existsSync(deps.ownSessionDir(candidate.id))) return null;
  } catch { return null; }
  return candidate.id;
}

/** Este usuário deve operar a sessão global legada? (rotas do WhatsApp) */
export async function usesLegacySession(user: SessionUser | null, deps: LegacyBridgeDeps): Promise<boolean> {
  if (user?.role !== 'SUPER_ADMIN') return false;
  return await legacySessionOwnerId(deps) === user.id;
}
