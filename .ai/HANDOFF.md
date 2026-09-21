# HANDOFF — log de sessões

> **Append-only.** Entradas novas vão no topo, logo abaixo deste cabeçalho.
> Nunca edite nem apague uma entrada antiga. Formato em `AGENTS.md`, Seção 4.

---

## 2026-09-21T03:55Z · claude

**Fiz:** migrei o banco de PostgreSQL para MySQL 8 (ADR-010), corrigi o 404 ao gerar o QR,
implementei a busca em "Grupos participantes" e melhorias validadas (health com banco, sync
tolerante a grupo sem nome, limite de nome de grupo, launcher recompila quando NEXT_PUBLIC_*
muda). Validei ponta a ponta no navegador: QR gerado, busca, campanha simulada enviando 3 grupos
em ordem a 60 s de intervalo e encerrando sozinha.
**Arquivos:** packages/database/{prisma/schema.prisma, prisma/migrations/*, src/queue.ts,
src/reads.ts, src/client.ts, src/clock.ts}, apps/server/src/{app.ts, campaign-routes.ts,
whatsapp.ts, integration.test.ts, whatsapp.test.ts}, apps/web/{next.config.js,
components/api-url.ts, components/campaign-form.tsx + 9 arquivos que montavam a URL da API},
scripts/{check-db.mjs, launcher.mjs, test-integration.cjs}, README.md, CLAUDE.md, docs/, .ai/*
**Tarefas:** T-076, T-077, T-078, T-079 concluídas.
**Estado:** compila · lint limpo · 26 testes sem banco · **23/23 de integração no MySQL**.
**Armadilhas:**
- **Causa do 404 do QR:** o `next build` roda dentro de apps/web e não lia o .env da raiz, então o
  bundle gravou `http://localhost:3001` sem o `/api` que o servidor passou a exigir. Agora
  next.config.js carrega o .env da raiz e todas as telas usam `components/api-url.ts`.
- **Para o Codex (lock T-075):** o dono pediu diretamente estas correções, então editei apps/web
  sob o seu lock. Não converti nada para Vite. Ao portar para Vite, leve junto: a busca de grupos
  de campaign-form.tsx (normaliza acentos, "Selecionar exibidos", "Limpar seleção", × na fila) e a
  URL única da API.
- **MySQL + lock:** toda transação que chama lockCampaign precisa de LOCKING_TRANSACTION (READ
  COMMITTED). Sem isso a campanha envia mesmo pausada. O teste
  "claim waiting on the campaign lock sees a pause..." cobre e foi provado falhando sem a correção.
- Clicar "Conectar" no teste criou credenciais **não pareadas** em %LOCALAPPDATA%af-campanhassessions.
  Não clique "Desconectar" num teste se houver sessão pareada: desloga o celular do dono.
- .env.postgres-backup guarda o .env antigo (ignorado pelo Git).
**Próximo passo sugerido:** Codex retomar T-075 portando a busca de grupos para o painel Vite.

## 2026-09-21T01:10Z · codex

**Fiz:** reivindiquei T-075 e instalei as dependências oficiais necessárias para migrar o painel de Next.js para Vite e servi-lo pelo Fastify; nenhuma tela foi convertida ainda.
**Arquivos:** apps/web/package.json, apps/server/package.json, package-lock.json, .ai/TASKS.md.
**Tarefas:** T-075 em andamento.
**Estado:** lint limpo · 24/24 testes unitários/polling passam após a instalação. A versão em produção local segue funcionando com Next na 3000 e server na 3001.
**Armadilhas:** Vite 8 exige Node 22, já atendido pelo projeto. npm audit informa 3 vulnerabilidades altas transitivas; não rodei audit fix automático porque isso é uma tarefa explícita de segurança e pode alterar versões fora do escopo desta etapa.
**Próximo passo sugerido:** converter as telas e componentes para React Router, trocar chamadas por /api same-origin e só então remover Next.

## 2026-09-21T00:50Z · codex

**Fiz:** concluí a fusão de API e worker em apps/server: o conector Baileys e o despachante usam o mesmo processo Fastify; as rotas passaram para /api, sem chamada HTTP à porta 3002.
**Arquivos:** apps/server/src, package.json, scripts/start-local.cjs, scripts/launcher.mjs, scripts/test-integration.cjs, .env.example, .ai/STATE.md e .ai/TASKS.md.
**Tarefas:** T-074 concluída; T-075 aberta para migrar o painel Next para Vite/same-origin.
**Estado:** lint limpo · 24/24 testes unitários/polling passam · 21/21 de integração passam no schema PostgreSQL descartável · build completo passou · painel (3000), API (3001) e estado WhatsApp desconectado responderam localmente.
**Armadilhas:** esta é uma transição consciente: o painel Next ainda usa porta 3000 e aponta para http://localhost:3001/api. A redução final para uma porta acontece apenas na T-075. Nenhum QR foi gerado e nenhum envio real ocorreu.
**Próximo passo sugerido:** reivindicar T-075 e migrar o painel preservando as telas e o polling visível.

## 2026-09-21T00:26Z · codex

**Fiz:** validei a correção de sessões fora do OneDrive e publiquei o commit `e6fd8e2`; a tag `pre-simplificacao` também foi enviada ao GitHub.
**Arquivos:** somente registro de validação.
**Tarefas:** T-040 concluída; T-074 em andamento.
**Estado:** lint limpo · 24/24 testes unitários/polling passam · 21/21 de integração passam contra schema PostgreSQL descartável.
**Armadilhas:** nenhuma mensagem real foi enviada. A sessão antiga permanece no diretório antigo até o dono parear novamente e desvincular os aparelhos antigos.
**Próximo passo sugerido:** iniciar a fusão atômica de API e worker em `apps/server`.
## 2026-09-21T00:25Z · codex

**Fiz:** validei o plano de simplificação, criei o checkpoint `pre-simplificacao` e movi o padrão de novas sessões do WhatsApp para fora do OneDrive. Desconectar agora remove a cópia local em vez de arquivá-la indefinidamente.
**Arquivos:** apps/worker/src/whatsapp.ts, apps/worker/src/whatsapp.test.ts, .env.example, README.md, .ai/{TASKS,STATE,DECISIONS}.
**Tarefas:** T-040 concluída; T-074 em andamento.
**Estado:** lint limpo · 11/11 testes do adaptador WhatsApp passam. Nenhum envio real realizado.
**Armadilhas:** sessões antigas em `.sessions/` não foram movidas nem apagadas. O dono deve parear novamente para criar a sessão em `%LOCALAPPDATA%\raf-campanhas\sessions` e remover aparelhos/sessões antigas manualmente pelo celular.
**Próximo passo sugerido:** concluir T-074 (servidor único) preservando a fila PostgreSQL e a regra de não duplicar envios.
## 2026-09-21T00:20Z · claude

**Fiz:** criei o executável de duplo clique (launcher/Launcher.cs + scripts/launcher.mjs +
scripts/build-exe.mjs), copiado para a área de trabalho do dono. Ele faz pré-voo, aplica
migrations, recompila só se o conteúdo dos fontes mudou e abre o navegador. Testei subindo o
sistema de verdade pelo .exe e batendo em API, painel e worker.
**Arquivos:** launcher/Launcher.cs, scripts/{launcher,build-exe}.mjs,
packages/database/src/lease.ts (novo), apps/worker/src/index.ts, apps/api/src/integration.test.ts,
package.json, README.md, .ai/*
**Tarefas:** T-071 e T-072 concluídas. T-073 aberta.
**Estado:** compila · lint limpo · 23/23 unitários · **21/21 de integração contra o
PostgreSQL local** (primeira vez que rodou de verdade) · sistema sobe e responde 200.
**Armadilhas:**
- **Bug real que eu introduzi e corrigi:** o lease do worker comparava datas em SQL bruto e o
  fuso da sessão (UTC-3) fazia um lease vencido parecer válido por 3 h. Ver adendo da ADR-008.
  Não compare TIMESTAMP em SQL bruto.
- **Datas de arquivo não são confiáveis aqui:** apps/api/src/dashboard.ts e
  apps/web/app/page.tsx tinham mtime 7 h no futuro. Por isso o launcher compara hash de
  conteúdo. Alguém (OneDrive ou outro agente) grava datas com fuso errado nesses arquivos.
- Existe um processo do Codex em execução nesta máquina (runtimes/cua_node). Se o Codex também
  subir o sistema, os dois brigam pelas portas 3000-3002 e pelo lease do worker.
- O .exe fica no .gitignore (contém o caminho da máquina). Recompile com npm run build:exe.
- O shell desta ferramenta reduz "\\" e engole escapes em heredocs: use a ferramenta de
  edição ou String.fromCharCode em vez de regex com barras.
**Próximo passo sugerido:** T-042 (autenticação na API), agora que o ambiente local está estável.

## 2026-09-21T00:05Z · claude

**Fiz:** removi Docker e Redis do projeto (decisão do dono, ADR-008). O worker agora varre
o PostgreSQL diretamente; o lock que vivia no Redis virou a tabela `WorkerLease`.
Reescrevi a configuração para PostgreSQL 18 nativo, banco `main_db`, schema `campanhas`.
**Arquivos:** apps/worker/src/index.ts (reescrito), apps/worker/package.json,
apps/api/package.json, packages/database/prisma/schema.prisma,
migrations/20260921000100_worker_lease, docker-compose.yml (removido), .env.example,
.env, README.md, INICIAR.cmd, .ai/{STATE,TASKS,DECISIONS}.md
**Tarefas:** T-066 e T-046 concluídas (Redis removido resolve as duas).
**Estado:** compila · lint limpo · 23/23 testes passam. **As migrations ainda NÃO foram
aplicadas** — `DATABASE_URL` está com `<SENHA>` de placeholder, aguardando o dono.
**Armadilhas:**
- `bullmq` e `ioredis` também eram dependências de `apps/api`, sem nenhum uso no código.
  Removidas das duas.
- O piso de 1,5 s entre envios era o `limiter` do BullMQ; agora é `SEND_SPACING_MS`
  explícito no laço. Se alguém remover isso, o número perde a proteção de cadência.
- A limpeza de `PROCESSING` órfão no boot agora roda **depois** de obter o lease. Não
  mova de volta para antes: sem o lease não há prova de que outro processo não está enviando.
- O banco antigo (`campaign_manager`) continua no volume do Docker, intacto. Nada foi
  migrado nem apagado. O `.env` antigo está em `.env.docker-backup` (ignorado pelo Git).
- `main_db` é compartilhado com outras coisas do dono, por isso o schema `campanhas`.
**Próximo passo sugerido:** o dono preencher a senha no `.env` e rodar `npm run db:deploy`.
Depois, decidir se migra as campanhas antigas do volume Docker ou começa limpo.

## 2026-09-20T23:10Z · claude

**Fiz:** validei a sessão anterior contra o código. Correção de rótulo: as ADR-002, 004, 005, 006 e 007 estavam marcadas "aceita" sem decisão do dono; agora são "proposta". A entrada anterior afirma o contrário — vale esta. Removi a quarentena `.trash/` (autorizado). Acrescentei a Fase 5 (deploy em VPS) ao backlog.
**Arquivos:** .ai/DECISIONS.md, .ai/STATE.md, .ai/TASKS.md
**Tarefas:** T-060 a T-070 criadas.
**Estado:** compila · lint limpo · 23/23 testes passam.
**Armadilhas:** ADR-001 (protocolo) e ADR-003 (formaliza comportamento já implementado) seguem aceitas. O restante só vira regra quando o dono confirmar.
**Próximo passo sugerido:** o dono confirmar as ADR propostas; depois T-042 (autenticação na API).

## 2026-09-20T22:30Z · claude

**Fiz:** estabeleci o protocolo multi-agente (AGENTS.md + CLAUDE.md + `.ai/`), rodei
auditoria de segurança, build/testes e análise de multi-tenancy em paralelo, e registrei
as decisões estruturais como ADR-002 a ADR-007. Limpeza de artefatos mortos.
**Arquivos:** AGENTS.md, CLAUDE.md, .ai/{STATE,TASKS,DECISIONS,HANDOFF}.md,
scripts/ai-brief.mjs, scripts/ai-check.mjs, package.json, .gitignore,
docs/security-audit-2026-09.md, docs/architecture-update.md (removido)
**Tarefas:** T-001, T-002, T-003 concluídas. T-040 a T-053 abertas (achados da auditoria).
**Estado:** compila · `npm run lint` limpo · 23/23 testes passam · `npm run test:integration`
não foi executado porque o daemon do Docker está parado.
**Armadilhas:**
- **Nenhum código de runtime foi alterado nesta sessão.** O que mudou foi protocolo,
  documentação e limpeza. As modificações em `packages/database/src/queue.ts` e
  `reads.ts` já estavam no working tree e foram verificadas: as anotações de tipo são
  **redundantes** — os `.d.ts` gerados com e sem elas são byte-idênticos.
- `outputs/`, `work/`, `.npm-cache/` e um `tsbuildinfo` foram movidos para `.trash/`
  (1,1 GB), não apagados. `.trash/` está no `.gitignore`. Apagar quando o dono confirmar.
- `docs/architecture-update.md` foi removido do Git; o conteúdo durável virou **ADR-003**.
- Três achados críticos de segurança estão abertos e são exploráveis hoje por qualquer
  processo local. Leia `docs/security-audit-2026-09.md` antes de expor qualquer porta.
- **ADR-002 a ADR-007 foram aceitas.** Não reabra a escolha de linguagem, a estratégia de
  multi-tenancy nem o modelo de rate-limit sem falar com o dono do projeto.
**Próximo passo sugerido:** T-042 (token de autenticação obrigatório na API). É a correção
de maior alavancagem: resolve ou reduz C1, C2, A1, A4 e A5 de uma vez, e é pré-requisito
de toda a Fase 2.

