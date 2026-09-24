import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@campaign/database';
import { legacyOwnerCandidate } from './legacy-session';
import { legacyWhatsappSessionDir, whatsappSessionDir } from './session-paths';

// Migração da sessão global legada para a pasta do dono (ADR-024, Fase 4E).
//
//   SESSIONS_DIR/whatsapp  ──rename──▶  SESSIONS_DIR/users/<dono>/whatsapp
//
// Por que rename e não cópia: a sessão tem dezenas de milhares de arquivos. Rename no mesmo
// disco é atômico e instantâneo; não existe estado "meio copiado", nada é duplicado e a volta
// é outro rename. Roda na partida, ANTES de qualquer conexão abrir (nenhum arquivo em uso).
//
// Garantias:
//   - só com dono inequívoco (mesma regra da ponte, legacy-session.ts);
//   - idempotente: depois de migrar não há mais sessão legada, e a próxima partida não faz nada;
//     as duas pastas existindo, não mexe em nenhuma;
//   - se o sistema operacional recusar o rename, a sessão legada continua onde está e a ponte
//     segue funcionando — nada se perde;
//   - nunca apaga, nunca faz logout, nunca abre arquivo da sessão para escrita.

export type MigrationOutcome =
  | { outcome: 'sem-sessao-legada' }
  | { outcome: 'dono-ambiguo' }
  | { outcome: 'conflito'; ownerId: string; detail: string }
  | { outcome: 'migrada'; ownerId: string; target: string }
  | { outcome: 'falhou'; ownerId: string; detail: string }
  | { outcome: 'desligada' };

type Options = {
  sessionsBase?: string;
  db?: typeof prisma;
  env?: NodeJS.ProcessEnv;
  /** Injetável só para simular falha do sistema operacional nos testes. */
  renameDir?: (from: string, to: string) => Promise<void>;
  log?: (message: string) => void;
};

/** Registro da migração, ao lado da pasta do usuário (fora da pasta do Baileys). */
export const migrationRecordPath = (ownerId: string, base?: string) => path.join(path.dirname(whatsappSessionDir(ownerId, base)), 'migracao-sessao-legada.json');

async function paired(dir: string) {
  try {
    const creds = JSON.parse(await readFile(path.join(dir, 'creds.json'), 'utf8')) as { me?: { id?: string } };
    return Boolean(creds.me?.id);
  } catch { return false; }
}

export async function migrateLegacySession(options: Options = {}): Promise<MigrationOutcome> {
  const env = options.env ?? process.env;
  const db = options.db ?? prisma;
  const log = options.log ?? ((message: string) => console.info('[WhatsApp]', message));
  if (env.WHATSAPP_MIGRATE_LEGACY === '0') return { outcome: 'desligada' };

  const legacyDir = legacyWhatsappSessionDir(options.sessionsBase);
  const legacyPaired = await paired(legacyDir);
  const ownerId = await legacyOwnerCandidate({ legacyProvider: { hasPairedSession: async () => legacyPaired }, db, env });

  if (!legacyPaired) {
    // Sem sessão legada: nada a fazer (inclui toda partida depois de uma migração bem-sucedida).
    return { outcome: 'sem-sessao-legada' };
  }
  if (!ownerId) {
    log('Sessão global encontrada, mas o dono não é inequívoco (defina LEGACY_SESSION_OWNER ou deixe um único SUPER_ADMIN ativo). Nada foi movido.');
    return { outcome: 'dono-ambiguo' };
  }

  const target = whatsappSessionDir(ownerId, options.sessionsBase);
  if (existsSync(target)) {
    // As duas existem: pode ser um pareamento novo feito pelo painel. Nunca escolhe sozinho.
    const detail = `A pasta ${target} já existe e a sessão global também. Nada foi movido; resolva manualmente.`;
    log(detail);
    return { outcome: 'conflito', ownerId, detail };
  }

  try {
    await mkdir(path.dirname(target), { recursive: true });
    await (options.renameDir ?? rename)(legacyDir, target);
  } catch (error) {
    const detail = (error as { code?: string }).code ?? (error instanceof Error ? error.message : 'erro');
    log(`Não foi possível mover a sessão global (${detail}). Ela continua onde estava e segue funcionando.`);
    // Pasta do usuário criada vazia não pode sobrar: ela desligaria a ponte.
    if (!existsSync(path.join(target, 'creds.json'))) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    return { outcome: 'falhou', ownerId, detail };
  }

  await writeFile(migrationRecordPath(ownerId, options.sessionsBase), JSON.stringify({ de: legacyDir, para: target, em: new Date().toISOString() }, null, 2)).catch(() => undefined);
  // A partir de agora a conexão é do usuário: reconecta sozinha na partida (Fase 4B).
  await db.whatsAppSession.upsert({ where: { userId: ownerId }, update: { autoConnect: true }, create: { userId: ownerId } });
  log(`Sessão global movida para a pasta do usuário ${ownerId}. Nenhum QR é necessário.`);
  return { outcome: 'migrada', ownerId, target };
}

export type RollbackOutcome = { outcome: 'revertida' | 'nada-a-reverter' | 'conflito'; detail?: string };

/**
 * Desfaz a migração: devolve a pasta do usuário para o lugar da sessão global. Usado só por
 * decisão do dono (npm run whatsapp:reverter-migracao), com o sistema parado.
 */
export async function rollbackLegacySession(ownerId: string, options: Pick<Options, 'sessionsBase' | 'renameDir'> = {}): Promise<RollbackOutcome> {
  const legacyDir = legacyWhatsappSessionDir(options.sessionsBase);
  const own = whatsappSessionDir(ownerId, options.sessionsBase);
  if (!existsSync(own)) return { outcome: 'nada-a-reverter' };
  if (existsSync(legacyDir)) return { outcome: 'conflito', detail: `A pasta ${legacyDir} já existe. Nada foi movido.` };
  await (options.renameDir ?? rename)(own, legacyDir);
  await rm(migrationRecordPath(ownerId, options.sessionsBase), { force: true }).catch(() => undefined);
  return { outcome: 'revertida' };
}
