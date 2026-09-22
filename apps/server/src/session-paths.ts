import path from 'node:path';
import { defaultSessionsDir } from './whatsapp';

// Onde ficam as sessões do WhatsApp de cada usuário (ADR-019, Fase 4A).
//
//   SESSIONS_DIR/
//     whatsapp/            ← sessão global atual; a 4A NÃO toca nela
//     users/<userId>/whatsapp/
//
// O caminho é montado só com o id interno do usuário (cuid gerado por nós). E-mail e nome
// nunca entram no caminho: vêm do cadastro, podem ter ".." , "/" , ":" e acentos.

/** Ids aceitos no caminho: o formato do cuid, sem separador, ponto ou espaço. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const sessionsRoot = (base = defaultSessionsDir()) => path.resolve(base);

/** Pasta que guarda as sessões por usuário. */
export const usersSessionsRoot = (base = defaultSessionsDir()) => path.join(sessionsRoot(base), 'users');

/**
 * Pasta da sessão de WhatsApp de um usuário. Recusa id inválido e qualquer caminho que
 * escape da pasta de sessões (path traversal), no Windows e no Linux.
 */
export function whatsappSessionDir(userId: string, base = defaultSessionsDir()) {
  if (typeof userId !== 'string' || !USER_ID.test(userId)) {
    throw new Error('Identificador de usuário inválido para o caminho da sessão.');
  }
  const root = usersSessionsRoot(base);
  const dir = path.resolve(root, userId, 'whatsapp');
  // Cinto e suspensório: mesmo com o id validado, confere que o resultado ficou dentro.
  const inside = path.relative(root, dir);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error('Caminho de sessão fora da pasta de sessões.');
  }
  return dir;
}

/**
 * Pasta da sessão global antiga, usada HOJE pelo sistema (um WhatsApp só). Existe aqui para
 * a 4E poder encontrá-la; a 4A não lê, não move e não apaga nada dentro dela.
 */
export const legacyWhatsappSessionDir = (base = defaultSessionsDir()) => path.join(sessionsRoot(base), 'whatsapp');
