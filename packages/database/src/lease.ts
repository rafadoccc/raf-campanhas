import type { PrismaClient } from '@prisma/client';

// Posse exclusiva do processador de envios, guardada numa linha do PostgreSQL.
//
// Deliberadamente NÃO usa SQL bruto com datas: a coluna é TIMESTAMP sem fuso e o
// Prisma grava UTC, mas uma comparação `"expiresAt" < $1` em SQL bruto converte a
// coluna pelo fuso da sessão do Postgres. Com America/Sao_Paulo (UTC-3), um lease
// só pareceria vencido 3 horas depois. A API de modelo trata o valor de forma
// consistente com o que gravou.

export const LEASE_ID = 'worker';

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002';

/** Toma a posse se estiver livre, vencida ou já for nossa. Devolve se conseguiu. */
export async function acquireLease(db: PrismaClient, owner: string, ttlMs: number, now = new Date()) {
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    await db.workerLease.create({ data: { id: LEASE_ID, ownerId: owner, expiresAt } });
    return true;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  // Um único UPDATE condicional: a disputa entre processos é decidida pelo banco.
  const taken = await db.workerLease.updateMany({
    where: { id: LEASE_ID, OR: [{ expiresAt: { lt: now } }, { ownerId: owner }] },
    data: { ownerId: owner, expiresAt }
  });
  return taken.count > 0;
}

/** Estende a posse. Devolve false se outro processo a tomou. */
export async function renewLease(db: PrismaClient, owner: string, ttlMs: number, now = new Date()) {
  const renewed = await db.workerLease.updateMany({
    where: { id: LEASE_ID, ownerId: owner },
    data: { expiresAt: new Date(now.getTime() + ttlMs) }
  });
  return renewed.count > 0;
}

/** Libera a posse apenas se ainda for nossa. */
export async function releaseLease(db: PrismaClient, owner: string) {
  await db.workerLease.deleteMany({ where: { id: LEASE_ID, ownerId: owner } });
}
