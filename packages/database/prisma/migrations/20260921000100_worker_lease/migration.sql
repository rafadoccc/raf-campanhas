-- Lease cooperativo do worker, substituindo o lock que vivia no Redis.
-- Aditiva: nenhuma tabela existente é alterada.
CREATE TABLE "WorkerLease" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerLease_pkey" PRIMARY KEY ("id")
);
