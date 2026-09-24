import { existsSync } from 'node:fs';
import { prisma } from '@campaign/database';
import type { SessionUser } from './auth';

// Ponte TEMPORÁRIA da sessão global legada (ADR-021, Fase 4C).
//
// A sessão que roda em produção hoje vive em SESSIONS_DIR/whatsapp e ainda não pertence a
// ninguém no banco: a migração é a 4E. Até lá, as rotas do WhatsApp precisam continuar
// mostrando essa conexão para quem realmente é o dono dela — e para mais ninguém.
//
// A ponte só liga quando TODAS estas condições valem, checadas a cada pedido:
//   1. quem pediu é SUPER_ADMIN (USER comum nunca, em hipótese alguma);
//   2. a pasta legada tem uma sessão pareada de verdade;
//   3. o dono é inequívoco: existe exatamente UM SUPER_ADMIN ativo (ou LEGACY_SESSION_OWNER
//      aponta explicitamente para um SUPER_ADMIN ativo);
//   4. esse usuário ainda NÃO tem pasta própria de sessão.
//
// Na 4E, a sessão passa para users/<id>/whatsapp: a condição 4 deixa de valer e a ponte se
// desliga sozinha. Depois disso este arquivo pode ser apagado inteiro.

export type LegacyBridgeDeps = {
  /** Provider global legado (o mesmo que o sistema usa hoje). */
  legacyProvider: { hasPairedSession(): Promise<boolean> };
  /** Onde ficaria a pasta própria deste usuário (WhatsAppManager.sessionDirFor). */
  ownSessionDir(userId: string): string;
  db?: typeof prisma;
  env?: NodeJS.ProcessEnv;
};

/** Este usuário deve operar a sessão global legada nas rotas do WhatsApp? */
export async function usesLegacySession(user: SessionUser | null, deps: LegacyBridgeDeps): Promise<boolean> {
  if (user?.role !== 'SUPER_ADMIN') return false;
  const db = deps.db ?? prisma;
  const env = deps.env ?? process.env;

  // Já tem pasta própria (migrado na 4E): a ponte não vale mais.
  let own = '';
  try { own = deps.ownSessionDir(user.id); } catch { return false; }
  if (existsSync(own)) return false;

  if (!await deps.legacyProvider.hasPairedSession()) return false;

  const declared = env.LEGACY_SESSION_OWNER?.trim();
  if (declared) return declared === user.id;

  // Sem declaração explícita, só quando não há dúvida: um único SUPER_ADMIN ativo.
  const admins = await db.user.findMany({ where: { role: 'SUPER_ADMIN', disabledAt: null }, select: { id: true }, take: 2 });
  return admins.length === 1 && admins[0].id === user.id;
}
