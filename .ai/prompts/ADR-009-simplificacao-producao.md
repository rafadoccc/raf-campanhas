# Prompt — Simplificação e endurecimento para produção (ADR-009)

> Cole o conteúdo abaixo de "INÍCIO DO PROMPT" em um agente de IA (Claude Code ou Codex CLI)
> aberto na raiz do repositório. Um agente por vez: o outro só entra na fase que lhe couber.

## INÍCIO DO PROMPT

Você vai simplificar e preparar para produção o repositório `raf-campanhas`
(https://github.com/rafadoccc/raf-campanhas), um gerenciador de campanhas de WhatsApp.
Trabalhe em português do Brasil nas mensagens de UI e nos documentos; nomes de código, tipos
e mensagens de commit em inglês.

### 0. Antes de escrever qualquer código

1. Leia `AGENTS.md` inteiro e siga o protocolo: rode `npm.cmd run ai:brief`, reivindique as
   tarefas em `.ai/TASKS.md` (crie IDs novos, sem reutilizar), e ao final atualize
   `.ai/STATE.md`, `.ai/DECISIONS.md` e `.ai/HANDOFF.md` e rode `npm.cmd run ai:check`.
2. Leia `.ai/DECISIONS.md`. Respeite a ADR-003 (a fila prefere perder uma entrega a duplicar)
   e a ADR-008 (PostgreSQL é a fila; sem Docker local, sem Redis). Escreva a **ADR-009**
   registrando esta decisão como aceita pelo dono (o envio deste prompt é a confirmação).
   As ADR-002, 004, 005, 006 e 007 continuam **propostas**: não as trate como regra.
3. Leia `docs/security-audit-2026-09.md`. Este trabalho fecha os achados C1, C2, C3, A1, A3,
   A4, A5, M3, M5, M6 (detalhes nas Fases 2 e 4).
4. Crie a tag `pre-simplificacao` no commit atual e envie: `git tag pre-simplificacao && git push origin pre-simplificacao`.
   É o ponto de retorno se algo der errado.
5. Registre a **linha de base** e a compare no final: `npm.cmd test` = 23 testes passando;
   `npm.cmd run test:integration` = 21 passando (exige o PostgreSQL local do `.env`);
   `npm.cmd run lint` limpo. **Nenhum teste existente pode ser removido nem enfraquecido**;
   podem ser adaptados quando a arquitetura mudar (ver seção 6).

### 1. Objetivo

Reduzir a pilha ao necessário para o escopo (um painel autenticado, uma API, um conector de
WhatsApp, um banco), **sem perder funcionalidade, correção nem qualidade**, e deixá-la pronta
para rodar em uma VPS. Alvo: **1 processo Node + PostgreSQL**, com o painel em Vite servido
pelo próprio Fastify na mesma origem.

Estado atual, verificado: três processos Node (`apps/web` Next 15 na porta 3000, `apps/api`
Fastify na 3001, `apps/worker` na 3002). A API chama o worker por HTTP
(`workerRequest` em `apps/api/src/server.ts`). Não há autenticação. O painel tem ~413 linhas:
5 páginas são server components (`/`, `/campanhas`, `/campanhas/[id]`, `/campanhas/[id]/editar`,
`/historico`) e 6 arquivos são de cliente (`configuracoes/page.tsx`, `campaign-actions`,
`campaign-form`, `campaign-media`, `live-refresh`, `server-clock`). Redis e Docker já foram removidos.

### 2. Princípios (valem para todas as fases)

- **Preservar comportamento.** A lógica de fila (`packages/database/src/queue.ts`), o
  planejador (`apps/api/src/schedule.ts`), o relógio, os recibos de leitura, as validações de
  mídia e as mensagens de erro ao usuário só podem ser movidas, nunca reescritas. Se precisar
  mudar a semântica, pare e explique no handoff.
- **Fases pequenas, cada uma em commits que deixam `lint`, `test` e `test:integration` verdes.**
  Faça commit e push direto em `main` por unidade lógica (Conventional Commits, assunto em
  inglês). **Não assine commits nem PRs com marca de IA**: sem `Co-Authored-By`, sem
  "Generated with". Nunca versione `.env`, `.sessions/`, `.runtime/` ou `launcher/*.exe`.
- **Nada de dependência nova sem justificar** na ADR-009 ou no handoff. Prefira a biblioteca
  padrão do Node. Não adicione ORMs, frameworks de estado, bibliotecas de UI, Zod nem Playwright.
- **Windows é o ambiente de desenvolvimento do dono.** Use `npm.cmd` em PowerShell. O shell
  desta máquina reduz `\\` a `\` em heredocs: edite arquivos pela ferramenta de edição, não por
  heredoc com barras. Não compare datas em SQL bruto contra colunas TIMESTAMP (ver adendo da ADR-008).
- **Não toque** em `.sessions/`, `.env`, no banco `main_db` fora do schema `campanhas`, nem
  execute envios reais de WhatsApp.

### 3. Arquitetura alvo

- `apps/server` (substitui `apps/api` e `apps/worker`): um processo Fastify que expõe a API
  sob `/api`, serve o painel estático e roda o despachante de envios e o conector WhatsApp.
  Mantenha os arquivos existentes com o mínimo de movimentação (`schedule.ts`, `media.ts`,
  `dashboard.ts`, `campaign-routes.ts`, `whatsapp.ts` e seus testes). Novos módulos: `config.ts`,
  `app.ts` (função `buildApp(deps)` que **não** chama `listen`), `main.ts` (compõe e inicia),
  `dispatcher.ts` (o laço de varredura hoje em `apps/worker/src/index.ts`, exportando
  `startDispatcher`/`stopDispatcher` em vez de rodar ao importar), `auth/`.
- `WhatsAppProvider` deixa de ser criado como singleton global: é instanciado em `main.ts` e
  **injetado** em `buildApp` e no despachante. Isso remove o `workerRequest`, a porta 3002 e o
  hack de `localhost` do worker, e prepara vários números no futuro sem implementá-los.
- `apps/web` vira Vite + React 19 + `react-router-dom`, gerando `apps/web/dist`. Em
  desenvolvimento o Vite roda na 5173 com proxy de `/api` para o servidor; em produção o Fastify
  serve `dist` com fallback de SPA para qualquer rota que não seja `/api`.
- `packages/database` permanece. O lease (`lease.ts`) continua garantindo uma instância só.
- Porta única `PORT` (padrão 3000). A API só responde sob `/api`; nomes de rotas atuais são
  preservados após o prefixo (`/api/campaigns`, `/api/whatsapp/status`, `/api/media/:id`, ...).

### 4. Fases

**Fase 1 — Fundir API e worker.**
Crie `apps/server` movendo o código de `apps/api` e `apps/worker` (use `git mv` para preservar
histórico). O despachante mantém exatamente: `SEND_SPACING_MS`, varredura de 5 s, envio sequencial,
espera pelo lease órfão (40 s) e a limpeza de `PROCESSING` órfão **somente depois** de obter o lease.
As rotas `/whatsapp/*` chamam o provider injetado diretamente. A ativação com `provider: 'baileys'`
consulta `provider.status()` em vez de `fetch` na 3002. Encerramento gracioso em SIGTERM/SIGINT:
parar de reservar novas entregas, aguardar o envio em andamento (até 30 s), fechar o socket,
liberar o lease, fechar o servidor e desconectar o Prisma. Remova `apps/api`, `apps/worker` e os
scripts `dev:api`/`dev:worker`. Critério: todos os testes existentes passam (adaptados),
sistema sobe com **uma** porta.

**Fase 2 — Configuração, endurecimento e autenticação.**
- `config.ts`: lê e valida o ambiente na partida e falha rápido com mensagem clara. Variáveis:
  `NODE_ENV`, `PORT`, `HOST` (padrão `127.0.0.1`; `0.0.0.0` só no contêiner), `PUBLIC_URL`,
  `DATABASE_URL`, `SESSIONS_DIR`, `CLOCK_SOURCE` (`network` = comportamento atual, `system` = relógio do
  host com NTP), `TRUST_PROXY`, `LOG_LEVEL`, `SESSION_TTL_HOURS`. Atualize `.env.example`.
  **Não remova o `ReferenceClock`**: ele existe porque o relógio do Windows do dono já esteve errado.
  Em produção usa-se `CLOCK_SOURCE=system`.
- Substitua a checagem fixa de `localhost` por lista de hosts e origem derivada de `PUBLIC_URL`
  (e `localhost`/5173 em desenvolvimento). Preserve o teste "foreign origins rejected".
  `trustProxy` só quando `TRUST_PROXY=1`.
- Sessões do WhatsApp em `SESSIONS_DIR`. Padrão fora do projeto: `%LOCALAPPDATA%\raf-campanhas\sessions`
  no Windows, `/var/lib/campanhas/sessions` no contêiner. Não migre nem apague `.sessions/` do
  dono: documente o passo manual. Pare de reter diretórios `-revoked-*` sem limite e trate o erro
  de `logout()` em vez de engolir.
- Autenticação (migration **aditiva**): tabelas `User` (`id`, `email` único, `name`, `passwordHash`,
  `role` OWNER|OPERATOR, `createdAt`, `disabledAt`) e `AuthSession` (`id`, `userId`, `tokenHash`,
  `expiresAt`, `createdAt`, `lastSeenAt`, `ip`, `userAgent`). Senha com `crypto.scrypt` do Node
  (sem addon nativo), sal por usuário, comparação com `timingSafeEqual`. O token de sessão é
  aleatório (32 bytes), enviado em cookie `httpOnly`, `SameSite=Lax`, `Secure` quando `PUBLIC_URL`
  é https; no banco guarda-se só o hash. Rotas `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`.
  **Negar por padrão**: um hook global exige sessão em toda rota `/api` exceto `/api/health`,
  `/api/auth/login`. Métodos que alteram estado exigem `Origin` igual à origem permitida.
  Não há cadastro público: crie `npm.cmd run user:create` (script interativo que pede e-mail e senha,
  sem gravá-los em log nem em histórico). Sem multi-organização nesta fase.
- Segurança (mapeie cada item à tarefa correspondente em `.ai/TASKS.md`): o QR e o `accountJid` só
  saem para usuário autenticado (C2, T-043); `bodyLimit` por tipo (16 MB imagem, 64 MB vídeo),
  sem a cópia dupla do buffer, e o `Range` de mídia sem materializar o arquivo inteiro (por
  exemplo `substring` parametrizado do `bytea`) (A5, T-048); `/deliveries` com `select` explícito
  sem `messageBody` (A4, T-047); `@fastify/rate-limit` global e mais estrito em login (M6, T-051);
  `@fastify/helmet` com CSP compatível com a UI (`style-src` pode precisar de `'unsafe-inline'`;
  valide no navegador); `setErrorHandler` que devolve mensagem genérica com id de requisição para
  erros inesperados e **mantém** as mensagens de domínio atuais (M3, T-050); `SIGKILL` de reserva no
  timeout do `ffprobe` (T-053).
- Observabilidade: log JSON do Fastify (pino) com id de requisição, `redact` para `cookie` e
  `authorization`; `/api/health` (vivo) e `/api/ready` (consulta `SELECT 1`, confirma a posse do lease
  e que o despachante rodou nos últimos 30 s).
- Critério: nenhuma rota `/api` responde sem sessão (teste que enumera as rotas registradas e
  verifica 401), login/logout funcionam, cookies com as flags corretas, `db:check`/launcher continuam válidos.

**Fase 3 — Painel em Vite.**
Reescreva `apps/web` com Vite + React + `react-router-dom`, **mantendo Tailwind 3, o visual e todos os
textos em pt-BR** (copie as classes; paridade visual é requisito). Rotas: `/`, `/campanhas`,
`/campanhas/:id`, `/campanhas/:id/editar`, `/nova-campanha`, `/configuracoes`, `/historico`,
`/grupos` (redireciona para `/configuracoes`), `/login`. Substitua os server components por
carregamento no cliente com um pequeno hook de dados sobre o `visible-polling.ts` **existente**
(mantenha-o e o teste `visible-polling.test.ts`); `LiveRefresh` vira esse polling de 15 s com a aba
visível; `readConnectionState` vira hook. Um `api.ts` central (`fetch` com `credentials: 'same-origin'`,
401 leva a `/login`, normaliza erros). A paginação de `?page=` é preservada. Mídia usa `/api/media/:id`.
Adicione nome do usuário e "Sair" à navegação. Remova `next`, `next-env.d.ts`, `next.config.js` e
`.next`. Critério: as 8 telas funcionam contra o servidor real em modo simulado; `npm.cmd run build`
gera `apps/web/dist`; comparação lado a lado com o painel antigo (use o navegador embutido ou capturas) sem
diferença de conteúdo nem de fluxo.

**Fase 4 — Empacotamento para produção.**
- `Dockerfile` multi-stage baseado em `node:22-bookworm-slim` (glibc, para `sharp` e `ffprobe-static`),
  usuário não-root, `npm ci --omit=dev` na imagem final, sem código de teste. Imagem única.
- `docker-compose.prod.yml` **somente para produção** (o desenvolvimento local continua nativo, sem
  Docker): serviços `app`, `postgres` (mesma versão maior do local, 18) e `caddy`; rede interna,
  **só o Caddy publica 80/443**; volumes `pgdata`, `sessions`, `caddy_data`; `restart: unless-stopped`;
  `stop_grace_period: 45s`; healthcheck do `app` em `/api/ready`; um serviço/etapa `migrate` que roda
  `prisma migrate deploy` antes do `app` (o CLI do Prisma precisa estar disponível nessa etapa).
  `Caddyfile` com `reverse_proxy app:3000`, HTTPS automático via `{$DOMAIN}` e compressão. Segredos em
  `.env.prod` (não versionado) com `.env.prod.example` documentado.
- `scripts/backup.sh` (`pg_dump -Fc` + cópia do volume de sessões com permissão restrita, retenção de
  14 dias) e `scripts/restore.sh`; documente e **teste o restore** em um banco descartável.
- `.github/workflows/ci.yml`: Node 22, serviço PostgreSQL, `npm ci`, `lint`, `build`, `test`,
  `test:integration`, build da imagem Docker (sem publicar). Sem segredos no workflow.
- `docs/deploy-vps.md`: passo a passo de VPS nova (usuário sem root, SSH por chave, `ufw` 22/80/443,
  `fail2ban`, `unattended-upgrades`, instalação do Docker, clone, `.env.prod`, subir, criar o primeiro
  usuário, verificação, atualização com rollback por tag). Aviso explícito: **uma única instância** do
  app (o lease impede a segunda), e que o WhatsApp pode restringir números em IP de datacenter.

**Fase 5 — Limpeza e documentação.**
Atualize `scripts/start-local.cjs`, `scripts/launcher.mjs` (`PORTS` passa a ser só a porta única) e os
scripts do `package.json` (`build`, `test`, `lint`, `dev`); o `.exe` **não** precisa ser recompilado porque
só chama `launcher.mjs`. Atualize `README.md`, `.ai/STATE.md` e os docs em `docs/` que citam porta 3001/3002,
`apps/api`, `apps/worker` ou Next. Remova dependências que ficaram sem uso e liste o saldo. Marque como
concluídas as tarefas cobertas (T-042 a T-045, T-047, T-048, T-050, T-051, T-053, T-060 a T-064,
T-067 a T-069) e mantenha abertas as que não foram feitas.

### 5. O que fica explicitamente fora de escopo

Multi-organização e múltiplas sessões de WhatsApp (ADR-004 a ADR-006, ainda propostas);
troca do Baileys; troca de linguagem do backend; retry automático de envios (proibido pela
ADR-003); publicar imagem em registro; provisionar ou acessar uma VPS real; enviar mensagens reais.
A migração das tabelas para `organizationId` virá depois, mas não a dificulte: mantenha o
provider injetável e o acesso a dados concentrado em `packages/database`.

### 6. Testes

- Preserve todos os testes. Ao adaptar: centralize o prefixo `/api` e a autenticação no helper
  `request` de `integration.test.ts` (crie usuário e sessão direto no banco e injete o cookie) em vez de
  editar cada teste. O mock de `http://127.0.0.1:3002/status` vira um provider falso passado a
  `buildApp`. `app` continua importável sem `listen`, sem iniciar Baileys nem o despachante.
- Adicione testes para: 401 em todas as rotas `/api` sem sessão; login correto/incorreto, expiração e
  logout; flags do cookie; rejeição de `Origin` estrangeira em métodos que alteram estado; SPA
  servindo `index.html` em rota desconhecida e **não** em `/api/*` inexistente; validação de `config.ts`;
  o limite de upload por tipo; `/api/ready` falhando sem lease.
- Todos os comandos abaixo devem passar antes de cada push: `npm.cmd run lint`, `npm.cmd test`,
  `npm.cmd run test:integration`. Ao final também: suba o sistema pelo launcher, faça login, percorra
  as telas em modo simulado e confirme o encerramento limpo (portas livres, lease liberado).

### 7. Entrega

Ao terminar, responda em português com: (1) o que mudou, por fase; (2) tabela antes/depois de
processos, portas, dependências diretas e linhas de código; (3) resultado dos três comandos de teste
(antes e depois, com contagens); (4) achados da auditoria fechados e os que continuam abertos;
(5) riscos e o que **não** foi possível verificar (envio real de WhatsApp, HTTPS com domínio real,
VPS real); (6) checklist manual para o dono. Deixe a entrada de handoff e rode `npm.cmd run ai:check`.

## FIM DO PROMPT
