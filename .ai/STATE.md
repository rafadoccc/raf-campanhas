# STATE — onde o projeto está agora

> Atualize este arquivo sempre que a arquitetura, a fase ou o conjunto de serviços mudar.
> Ele responde a uma pergunta: *se eu chegasse agora, o que eu precisaria saber?*

**Última atualização:** 2026-09-21 · por `codex`

---

## Fase atual

**Simplificação — etapa 1 concluída.** O backend agora é um processo único; a migração do painel para mesma origem ainda é a próxima etapa.
O código continua assumindo **um usuário, um número de WhatsApp e sem autenticação**.

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
apps/web      Next.js 15 (App Router, React 19, Tailwind)   → porta 3000 (transição)
apps/server   Fastify 5 + Baileys + despachante MySQL        → porta 3001, API em /api
packages/database  Prisma 6 + MySQL 8 (nativo no Windows, banco `campanhas`)
infra         nenhuma. Sem Docker, sem Redis. Ver ADR-008 e ADR-010.
```

Dois processos temporários sobem por scripts/start-local.cjs: o painel Next e o novo servidor único. A etapa seguinte substitui o painel por Vite estático servido pelo Fastify, reduzindo para uma porta e um processo Node.

### Fluxo de uma campanha

1. Usuário cria campanha (`DRAFT`) escolhendo grupos, mensagens, intervalo e modo.
2. Ao ativar, `apps/server/src/schedule.ts::planDeliveries` materializa **todas** as
   entregas no MySQL com `sequence` fixa. Isso só acontece na primeira ativação.
3. O despachante interno de apps/server varre o MySQL a cada 5s e pega o **primeiro pendente** de cada campanha.
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
| 12 | Mídia como `Bytes` (LONGBLOB) no MySQL, sem cota nem exclusão | Crescimento ilimitado; 128 MB de RAM por request (A5). |
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
# MySQL 8 nativo (serviço MySQL80); nenhum container é necessário.
npm install
npm run db:deploy           # aplica migrations
npm run db:generate         # gera o client Prisma
npm run build
npm run start:local         # sobe o painel e o servidor único de transição
npm run build:exe -- --desktop   # gera o .exe de duplo clique (pré-voo + build só se mudou)
npm run db:check            # diagnóstico do MySQL local (cria o banco se faltar)
npm test                    # testes sem WhatsApp
npm run test:integration    # banco MySQL descartável
npm run lint                # tsc --noEmit em tudo
```
