# STATE — onde o projeto está agora

> Atualize este arquivo sempre que a arquitetura, a fase ou o conjunto de serviços mudar.
> Ele responde a uma pergunta: *se eu chegasse agora, o que eu precisaria saber?*

**Última atualização:** 2026-09-20 · por `codex`

---

## Fase atual

**Fase 1 — Endurecimento.** Saindo de protótipo mono-usuário rumo a produção multi-tenant.
O código atual funciona, mas assume **um usuário, um número de WhatsApp, sem autenticação**.

Fases planejadas:

| Fase | Objetivo | Status |
|---|---|---|
| 0 | Protótipo local funcional | ✅ concluída |
| 1 | Protocolo multi-agente, limpeza, auditoria | 🔄 em andamento |
| 2 | Autenticação + organizações + papéis | ⬜ não iniciada |
| 3 | Múltiplas sessões de WhatsApp por organização | ⬜ não iniciada |
| 4 | Observabilidade, backup, deploy | ⬜ não iniciada |

---

## Arquitetura vigente

```
apps/web      Next.js 15 (App Router, React 19, Tailwind)   → porta 3000
apps/api      Fastify 5                                      → porta 3001
apps/worker   Baileys + varredura do PostgreSQL              → porta 3002
packages/database  Prisma 6 + PostgreSQL 18 (nativo no Windows)
infra         nenhuma. Sem Docker, sem Redis. Ver ADR-008.
```

Os três serviços sobem juntos por `scripts/start-local.cjs`, todos em `127.0.0.1`.

### Fluxo de uma campanha

1. Usuário cria campanha (`DRAFT`) escolhendo grupos, mensagens, intervalo e modo.
2. Ao ativar, `apps/api/src/schedule.ts::planDeliveries` materializa **todas** as
   entregas no Postgres com `sequence` fixa. Isso só acontece na primeira ativação.
3. O worker varre o PostgreSQL a cada 5s e pega o **primeiro pendente** de cada campanha.
4. `claimDelivery` reserva PENDING→PROCESSING sob lock da campanha (`SELECT ... FOR UPDATE`).
5. Envio via Baileys ou simulador. `finishDelivery` grava SENT/FAILED e empurra
   `nextAvailableAt` em `intervalSeconds`.

### Invariantes que NÃO podem ser quebradas

- Uma entrega reservada **nunca** é repetida automaticamente. Falha ⇒ resultado incerto,
  sem retry. É uma escolha deliberada contra duplicatas.
- Só o primeiro pendente (`sequence` mínima) de uma campanha pode ser reservado.
- O intervalo é contado a partir do **fim** da tentativa anterior, não do início.
- `Delivery` tem `@@unique([campaignId, sequence])` e `@@unique([campaignId, groupId, scheduledAt])`.

---

## O que está quebrado ou ausente

Auditoria completa em `docs/security-audit-2026-09.md` (3 críticos, 6 altos, 6 médios).
Tarefas correspondentes: T-040 a T-053 em `.ai/TASKS.md`.

| # | Problema | Impacto |
|---|---|---|
| 1 | **Sem autenticação alguma** | Acesso ao loopback = controle total. Qualquer processo local dispara envio real (C1) e captura o QR de pareamento (C2). |
| 2 | **Sessões antigas podem estar no OneDrive** | Novas sessões usam `%LOCALAPPDATA%\\raf-campanhas\\sessions`; o dono ainda precisa parear novamente e desvincular aparelhos antigos (C3 parcialmente mitigado). |
| 3 | **Sem multi-tenancy** | Nenhuma tabela tem escopo de organização. Ver ADR-004. |
| 4 | `WhatsAppProvider` é singleton com `authDir` fixo | Impossível ter 2 números. Ver ADR-006. |
| 5 | `sync()` faz `updateMany` global desativando grupos | Com 2 sessões, sincronizar B derruba os grupos de A. Ver ADR-005. |
| 6 | `Group.externalId @unique` global | Duas sessões no mesmo grupo sequestram a linha uma da outra. |
| 7 | Rate-limit na campanha, não no número | 3 campanhas no mesmo número não se coordenam: o piso de intervalo do número não existe. Ver ADR-006. |
| 8 | Lease único em `WorkerLease` | Só 1 worker no sistema inteiro (por ora, correto). |
| 10 | Validação de entrada manual e espalhada | Sem schema declarativo; fácil divergir. |
| 11 | Sem logs estruturados, métricas ou tracing | Impossível operar às cegas. |
| 12 | Mídia como `Bytes` no Postgres, sem cota nem exclusão | Crescimento ilimitado; 128 MB de RAM por request (A5). |
| 13 | Sem CI | Nada impede um merge quebrado. |

---

## Riscos conhecidos (não são bugs — são escolhas)

- **Baileys é não oficial.** Risco real de banimento do número. A API oficial da Meta
  (Cloud API) **não envia para grupos**, então não é substituta para este caso de uso.
- Recibos de leitura são aproximados. Ausência de recibo não prova ausência de leitura.
- `ReferenceClock` sincroniza com HTTP `Date` do Google/Cloudflare; não é NTP.

---

## Comandos que você vai precisar

```bash
# PostgreSQL 18 nativo; nenhum container é necessário.
npm install
npm run db:deploy           # aplica migrations
npm run db:generate         # gera o client Prisma
npm run build
npm run start:local         # sobe os três serviços
npm run build:exe -- --desktop   # gera o .exe de duplo clique (pré-voo + build só se mudou)
npm run db:check            # diagnóstico do PostgreSQL local
npm test                    # testes sem WhatsApp
npm run test:integration    # schema Postgres descartável
npm run lint                # tsc --noEmit em tudo
```
