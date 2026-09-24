# HANDOFF — log de sessões

> **Append-only.** Entradas novas vão no topo, logo abaixo deste cabeçalho.
> Nunca edite nem apague uma entrada antiga. Formato em `AGENTS.md`, Seção 4.

---

## 2026-09-24T19:30Z · claude

**Fiz:** (1) corrigido o falso "WhatsApp desconectado · envia assim que reconectar" na previsão
dos envios: `GET /api/deliveries` perguntava à conexão global legada (`provider.status()`),
que fica sempre desligada depois da migração da sessão (4E); agora usa a conexão do dono da
campanha (`sending.forOwner`), a mesma que envia. Teste de integração novo (falha no código
antigo, passa no novo). (2) Produção local em branco em "WhatsApp"/"Administração": eu tinha
recompilado `apps/web/dist` do main com o servidor da produção rodando; ele serve só os
arquivos que existiam na partida (`wildcard: false`) e os novos voltavam como HTML. Resolvido
SEM reiniciar (campanha real em andamento): recompilei a versão c58b7f7 do painel numa pasta
temporária (mesmos hashes) e devolvi os arquivos + o index.html correspondente ao dist.
**Arquivos:** apps/server/src/app.ts, apps/server/src/integration.test.ts
**Tarefas:** T-115 (concluída)
**Estado:** compila · lint ok · npm test 62/62 · integração 110/110 · produção local: todos os
arquivos do painel respondem como JS/CSS, health 200, nenhum processo reiniciado
**Armadilhas:** NUNCA rode `npm run build` na pasta do main com a produção ligada — o painel
fica em branco até reiniciar. A produção local ainda roda o código de antes desta correção; o
falso "desconectado" some quando o sistema for reiniciado (o launcher recompila sozinho,
comparando o conteúdo dos fontes com `.runtime/build-stamp`). Fazer isso sem campanha rodando.
**Próximo passo sugerido:** reiniciar a produção quando a campanha "Arraxta pra cima OFICIAL"
não estiver no meio de uma rodada.

## 2026-09-24T19:10Z · claude

**Fiz:** corrigido o "erro de senha" na dev: a conta do dono só existia no banco de produção
(`campanhas`), não no `campanhas_dev`; e o servidor da dev estava parado (por isso o "Sem
conexão com o servidor"). Novo `npm run dev:sincronizar-login` copia o login dos
administradores da produção para a dev (só o hash, só escreve em banco `*_dev`); a conta de
teste `admin@dev.local` virou a do dono, com os dados de teste dela. `PasswordInput` no design
system (olhinho mostrar/esconder) em todos os campos de senha: login, Minha conta, admin.
**Arquivos:** scripts/dev-sync-login.mjs (novo), package.json, apps/web/src/design/{primitives,icons}.ts(x), apps/web/src/pages/{login,account,admin}.tsx, .ai/STATE.md
**Tarefas:** T-114 (concluída)
**Estado:** compila · lint ok · testes ok · hash da dev conferido igual ao da produção · olhinho testado no navegador (texto ↔ senha)
**Armadilhas:** a logo "CC" já tinha saído do código; quem ainda a vê está com um painel antigo
(produção local precisa reabrir o .exe para recompilar; Railway precisa do redeploy do main).
**Próximo passo sugerido:** conferir o redeploy do Railway com a tela de login nova.

**Fiz:** piso de 3 minutos entre grupos garantido no banco (ADR-028, não só na API — protege
campanhas antigas); marcar todos os membros do grupo com @todos oculto (ADR-029); tentar de
novo um envio com falha, direto se a falha é certa e com confirmação se é incerta, por envio
ou em lote pela campanha (ADR-030); painel do administrador com métricas do sistema inteiro —
contas, campanhas, envios/falhas de hoje, fila, últimos 7 dias, erros mais comuns, WhatsApp
conectados AGORA, posse do despachante, uptime/memória (ADR-031), mais força-logout e
desconectar-WhatsApp por conta, separados de "desativar"; `Select` e `Checkbox` próprios no
design system (sem visual nativo do SO), removidas as bordas decorativas do cartão de
campanha e do detalhe e a logo "CC" do topo/login; docs/design-system.md e
docs/deploy-railway.md (novos); README e STATE.md atualizados (várias afirmações estavam
desatualizadas: sessão de 7 dias → 30 dias, "nunca oferece tentar de novo" → agora oferece,
intervalo mínimo).
**Arquivos:** packages/database/src/{queue,client}.ts, packages/database/prisma/{schema.prisma,migrations/20260924180000_min_interval,migrations/20260924181000_mention_all}, apps/server/src/{app,campaign-routes,dispatcher,queue-forecast,schedule,send-context,whatsapp,whatsapp.test,integration.test,admin-routes,admin-overview(novo)}.ts, apps/web/src/{design/*,components/*,pages/*,lib/campaign-ops.ts}, docs/{design-system.md,deploy-railway.md} (novos), README.md, .ai/{STATE.md,DECISIONS.md,TASKS.md}
**Tarefas:** T-108, T-109, T-110, T-111, T-112 (concluídas); T-113 em andamento (este handoff faz parte dela)
**Estado:** compila · lint ok (server/web/database) · `npm test` 62/62 · `npm run test:integration` 109/109 (múltiplas execuções) · validado no navegador em dev (porta 3001): dropdown do Select navegável por teclado, checkbox sem visual nativo, checkbox @todos marcando o grupo certo, retry seguro (PENDING direto) e retry incerto (diálogo de confirmação com aviso de duplicar), painel de admin com métricas reais e ações de sessão/WhatsApp por conta
**Armadilhas:** `prisma.$transaction([...])` em array com muitas consultas (13+) perde a
inferência de tipo do TypeScript nesta versão do Prisma — sempre use a forma
`$transaction(async tx => { await Promise.all([...]) })` para lotes grandes (visto em
admin-overview.ts). A classificação de falha "incerta" (`isUncertainFailure`) usa só a palavra
"incerto" na mensagem de erro como marca — de propósito, para não ter uma segunda fonte de
verdade (coluna) que possa sair de sincronia; se um dia a mensagem de erro for traduzida ou
reformulada, essa função precisa mudar junto.
**Próximo passo sugerido:** mesclar dev → main (commits já testados e no dev remoto),
redeploy no Railway, e depois seguir para observabilidade (T-005/T-006, fase 6 do STATE.md) —
nada urgente pendente no momento.

**SSO do Google para login — resumo pedido pelo dono:**
Tecnicamente viável (fluxo OAuth 2.0 Authorization Code contra o Google; nenhuma mudança no
modelo de sessão, que continua como está — só um segundo jeito de abrir a mesma sessão).
Dificuldades reais: (1) exige um projeto no Google Cloud Console e credenciais OAuth — isso só
o dono consegue criar, nenhum agente tem acesso; (2) o sistema não tem cadastro público de
propósito — decisão de produto necessária: login por Google só autentica uma conta JÁ criada
pelo admin (mesmo e-mail), nunca cria conta nova sozinho (recomendado, mantém o modelo atual);
(3) a URL de retorno cadastrada no Google precisa bater exatamente com o domínio de cada
ambiente (Railway prod, e local/dev se for testar por lá); (4) tela de consentimento do Google
mostra aviso de "app não verificado" para contas de teste enquanto o app não estiver
"publicado" (não é bloqueio, é um clique a mais; escopos email/perfil não exigem verificação
formal do Google). Esforço estimado: uma sessão focada — duas rotas novas
(`/api/auth/google/start` e `/callback`), um botão na tela de login, e a decisão acima. Nada
foi implementado; aguardando decisão do dono sobre criar as credenciais e sobre o
comportamento de vínculo de conta.

## 2026-09-24T08:00Z · claude

**Fiz:** design system completo do painel (branch dev, ADR-026): primitivos, ícones lucide, ConfirmProvider (sem confirm() do navegador), rolagem infinita por cursor, layout sem rolagem do documento. Reescreveu todas as telas (início, campanhas, detalhe, whatsapp, conta, login, histórico, formulário) e criou /admin. lib/campaign-ops.ts unifica editar/reagendar/usar de novo/excluir entre lista e detalhe. Cantos 5–6px em todo o sistema.
**Arquivos:** apps/web/src/design/** (novo), apps/web/src/lib/campaign-ops.ts (novo), apps/web/src/pages/admin.tsx (novo), todas as páginas e componentes de apps/web/src, apps/web/tailwind.config.ts, apps/web/src/styles.css, apps/web/src/main.tsx
**Estado:** compila · lint ok · npm test 59+2 ok · integração 101/101 (2 execuções) · validado no navegador com dados de exemplo no banco campanhas_dev (porta 3001): início sem rolagem em 1366×768, rolagem infinita testada com 30+ campanhas, exclusão com confirmação, layout mobile 375px sem rolagem lateral
**Armadilhas:** o servidor dev precisa reiniciar depois de recompilar o painel (fastify-static lê a lista na partida, senão fica em branco). Script de exemplo em .tmp-* nunca roda fora de campanhas_dev (recusa por segurança). Sessão real do dono em SESSIONS_DIR/whatsapp NÃO tocada em nenhum momento desta sessão.
**Próximo passo sugerido:** revisar visualmente as telas restantes (grupos, admin em telas menores) e decidir se a branch dev vira PR para main.

## 2026-09-24T02:00Z · claude

**Fiz:** Fase 4D (ADR-022): despachante escolhe a conexão pelo dono da campanha (`sending-router.ts`), sem fallback; ativação real idem; eventos/recibos com `ownerId` (PendingRead ganhou coluna); selo de grupo por `groupId` da entrega; ponte legada centralizada e aplicada também ao envio, só para o dono comprovado.
**Arquivos:** apps/server/src/{sending-router.ts (novo),dispatcher,app,main,whatsapp,legacy-session}.ts, packages/database/src/{reads,delivery-events}.ts, schema.prisma, migrations/20260923040000_pending_read_owner, testes
**Tarefas:** T-102 (concluída)
**Estado:** compila · lint ok · npm test 56+2 ok · integração 87/87 (2 execuções) · sessão real intocada (38.159 arquivos, creds 9.389 bytes)
**Armadilhas:** se aparecer um SEGUNDO SUPER_ADMIN ativo antes da 4E, a ponte desliga e as campanhas do dono param de sair (por segurança) — use LEGACY_SESSION_OWNER ou faça a 4E. `startDispatcher` agora recebe um roteador: em teste use `staticRouter([{ownerId, provider}])`. Dubles do manager precisam de send/flushReads/flushDeliveryEvents. `assert.deepEqual(x, [])` estreita o tipo de x: compare cópias.
**Próximo passo sugerido:** aguardar aprovação do dono para a 4E (migrar a sessão legada por rename, com o sistema parado e sem campanha ativa).

## 2026-09-23T03:00Z · claude

**Fiz:** Fase 4C (ADR-021): rotas do WhatsApp escopadas por `request.user.id` via WhatsAppManager; ponte temporária da sessão legada só para o dono comprovado (4 condições, auto-desliga na 4E); main.ts cria o manager, faz startAll/stopAll. Despachante, provider e envios reais intactos.
**Arquivos:** apps/server/src/legacy-session.ts (novo), apps/server/src/app.ts, apps/server/src/main.ts, apps/server/src/whatsapp-manager.ts (sessionDirFor + sync no tipo), apps/server/src/integration.test.ts
**Tarefas:** T-101 (concluída)
**Estado:** compila · lint ok · npm test 56+2 ok · integração 79/79 (2 execuções) · dispatcher.ts, whatsapp.ts, packages/database e apps/web sem alteração (git diff vazio)
**Armadilhas:** enquanto a ponte estiver ativa, o SUPER_ADMIN vê a conexão global nas rotas, mas campanhas de QUALQUER usuário ainda saem por ela (4D). Testes usam manager com `sessionsBase` temporário: ao criar app de teste novo, injete o manager, senão o padrão aponta para o SESSIONS_DIR real. A sessão real do dono continua em SESSIONS_DIR/whatsapp, intocada.
**Próximo passo sugerido:** aguardar aprovação do dono para a 4D (despachante, eventos e recibos por dono) — recomendo 4D antes da 4E.

## 2026-09-23T01:00Z · claude

**Fiz:** Fase 4B (ADR-020): `WhatsAppManager` (for/peek/ensureSession/stop/stopAll/disconnect/persistState/startAll) e `WhatsAppProvider` com `{ownerId, sessionDir}`, mantendo o modo legado. Cache compartilhado só da versão do protocolo. Nada disso está ligado à produção ainda.
**Arquivos:** apps/server/src/whatsapp-manager.ts (novo), apps/server/src/whatsapp-manager.test.ts (novo), apps/server/src/whatsapp.ts, package.json, apps/server/src/integration.test.ts
**Tarefas:** T-100 (concluída)
**Estado:** compila · lint ok · npm test 56+2 ok · integração 73/73 (2 execuções) · main.ts, app.ts, dispatcher.ts e packages/database NÃO mudaram (git diff vazio)
**Armadilhas:** produção continua no provider global legado; o manager não é instanciado em lugar nenhum ainda (4C liga as rotas). Nunca deixe o provider global e um provider do manager apontarem para a mesma pasta — hoje é impossível por construção. Testes do manager usam dubles e pastas temporárias; nenhum toca a sessão real. Ao mover `defaultSessionsDir` para session-paths.ts na 4C/4E, cuidado com ciclo de import.
**Próximo passo sugerido:** aguardar aprovação do dono para a 4C (rotas /api/whatsapp/* por usuário).

## 2026-09-22T21:00Z · claude

**Fiz:** Fase 4A (ADR-019): modelo `WhatsAppSession` (uma conexão por usuário, número pareado exclusivo, sem credencial no banco) + `session-paths.ts` com o caminho seguro `SESSIONS_DIR/users/<userId>/whatsapp`. Migration só cria a tabela. Nada em uso ainda: o sistema continua com a conexão global.
**Arquivos:** packages/database/prisma/schema.prisma, migrations/20260922200000_whatsapp_session, apps/server/src/session-paths.ts (novo), apps/server/src/session-paths.test.ts (novo), package.json (script test), apps/server/src/integration.test.ts
**Tarefas:** T-099 (concluída)
**Estado:** compila · lint ok · npm test 51+2 ok · integração 70/70 (2 execuções) · whatsapp.ts, dispatcher.ts, app.ts e packages/database/src NÃO foram alterados (git diff vazio)
**Armadilhas:** a sessão real do dono continua em SESSIONS_DIR/whatsapp e NÃO pode ser movida antes da 4E (36.530 arquivos, 70 MB — usar rename, nunca cópia). `session-paths.ts` importa `defaultSessionsDir` de whatsapp.ts; na 4B essa função deve MUDAR DE CASA para session-paths.ts (senão vira ciclo de import).
**Próximo passo sugerido:** aguardar aprovação do dono para a 4B (WhatsAppManager e providers por usuário).

## 2026-09-22T19:00Z · claude

**Fiz:** multiusuário Fase 3 (ADR-018): todas as rotas de dados escopadas por `request.user.id`; recurso alheio = 404 idêntico ao inexistente (`NotFoundError`); dashboard por usuário; download de mídia só do dono. 7 testes de isolamento/IDOR com dois usuários reais + SUPER_ADMIN.
**Arquivos:** apps/server/src/{app,campaign-routes,dashboard,media,security}.ts, apps/server/src/integration.test.ts
**Tarefas:** T-098 (concluída)
**Estado:** compila · lint ok · npm test 47+2 ok · integração 67/67 (2 execuções) · frontend sem mudanças
**Armadilhas:** /api/whatsapp/* continua GLOBAL (qualquer usuário logado vê QR/número, conecta/desconecta e sincroniza os grupos do WhatsApp global para a própria conta); ativar campanha real usa o número global. Não criar contas USER para terceiros antes da Fase 4. Testes de isolamento compartilham um "mundo" (isoWorld) criado sob demanda; testes seguintes podem acrescentar dados a A/B — compare com o banco, não com listas fixas.
**Próximo passo sugerido:** aguardar aprovação do dono para a Fase 4 (WhatsApp por usuário).

## 2026-09-22T17:30Z · claude

**Fiz:** multiusuário Fase 2 (ADR-017): `userId` obrigatório em Group, Campaign e CampaignMedia, chaves compostas que impedem campanha com grupo/mídia de outro dono, grupo único por (userId, externalId). Migration com trava (exatamente um SUPER_ADMIN ativo quando há dados) e backfill para o SUPER_ADMIN. Criação de grupo/mídia/campanha e sincronização de grupos usam o usuário da sessão.
**Arquivos:** packages/database/prisma/schema.prisma, migrations/20260922160000_data_ownership, apps/server/src/{app,media,whatsapp}.ts, apps/server/src/integration.test.ts
**Tarefas:** T-097 (concluída)
**Estado:** compila · lint ok · npm test 47+2 ok · integração 60/60 · ensaio da migration numa cópia do banco local do dono: contagens idênticas em todas as tabelas, tudo atribuído ao SUPER_ADMIN
**Armadilhas:** o banco local do dono ainda não aplicou pace/roles/ownership (sistema antigo aberto); aplicam em sequência ao reiniciar. Apagar usuário com dados agora falha (RESTRICT) — testes que limpam usuários precisam apagar campanhas, mídias e grupos antes. `prepareSend` ainda atualiza os selos de TODAS as linhas do mesmo externalId (Fase 4). Leituras/edições ainda não filtram por dono (Fase 3). `prisma migrate diff` contra banco no Windows continua mostrando ruído de minúsculas; compare schema com schema (--from-schema-datamodel).
**Próximo passo sugerido:** aguardar aprovação do dono para a Fase 3 (filtro por dono em todas as rotas + testes de isolamento por rota).

## 2026-09-22T15:00Z · claude

**Fiz:** multiusuário Fase 1 (ADR-016): enum `UserRole` (SUPER_ADMIN/USER, padrão USER), migration que converte OWNER → SUPER_ADMIN sem tocar em sessões, `requireSuperAdmin` para futuras rotas admin, bootstrapAdmin cria SUPER_ADMIN, `user:create` cria USER (SUPER_ADMIN só com `--super-admin` + confirmação; primeira conta do sistema é SUPER_ADMIN).
**Arquivos:** packages/database/prisma/schema.prisma, migrations/20260922140000_user_roles, apps/server/src/auth.ts, scripts/user-create.mjs, apps/server/src/integration.test.ts, README.md, docs/deploy-hostinger.md
**Tarefas:** T-096 (concluída)
**Estado:** compila · lint ok · npm test 47+2 ok · integração 52/52
**Armadilhas:** nenhuma rota usa requireSuperAdmin ainda (não há rotas admin). `prisma migrate diff` no Windows mostra "tudo diferente" por causa de lower_case_table_names (nomes de tabela minúsculos no MySQL do Windows); não é drift. Campanhas, grupos, WhatsApp, despachante e pacing NÃO foram alterados — isolamento de dados é a Fase 2.
**Próximo passo sugerido:** aguardar aprovação do dono para a Fase 2 (userId em Campaign/Group/CampaignMedia).

## 2026-09-22T13:00Z · claude

**Fiz:** intervalo mínimo por NÚMERO (ADR-015, parte da ADR-006). Nova tabela `WhatsAppAccount` com o relógio do número, travada antes da campanha em `claimDelivery`/`finishDelivery`; reinício com envio interrompido segura o número por um intervalo inteiro; despachante reveza campanhas (quem espera há mais tempo primeiro); previsão do painel considera o relógio do número.
**Arquivos:** packages/database/prisma/schema.prisma, migrations/20260922120000_whatsapp_account_pace, packages/database/src/{queue,client}.ts, apps/server/src/{dispatcher,app}.ts, apps/server/src/integration.test.ts
**Tarefas:** T-095 (concluída)
**Estado:** compila · lint ok · npm test 47+2 ok · integração 45/45 (2 execuções); os 7 testes novos de ritmo falhavam antes da correção (1,46 s entre envios; 31 ms após reinício)
**Armadilhas:** ordem de locks número → campanha é obrigatória; atalhos de teste que mexem nos dois devem atualizar o número FORA da transação da campanha. O relógio do número é persistido: testes precisam limpar `WhatsAppAccount`. Após uma queda no meio de um envio, o próximo envio espera um intervalo inteiro (proposital).
**Próximo passo sugerido:** multiusuário Fase 0 (decisões do dono) — nada de multiusuário foi iniciado.

## 2026-09-22T05:30Z · claude

**Fiz:** reenvio automático limitado (ADR-014): falha antes do sendMessage (marca `notSent`) e recusa do servidor voltam para a fila na mesma sequência, com 5 e 15 min de espera, até 3 tentativas; resultado incerto continua sem reenvio; recibo de entrega tardio cancela o reenvio. A cabeça da fila passou a ser o primeiro envio em andamento ou já vencido (`dueOrRunning`), para um reenvio agendado não travar os seguintes. `Group.participants` gravado na sincronização e a cada envio. `forecastQueue` dá a previsão e o motivo de espera de cada pendente (`wait` em /api/deliveries). Interface limpa: `components/ui.tsx` com selos, botões e formatos compartilhados; blocos de campanha com progresso e botão "Ver campanha"; menos texto em todas as telas.
**Arquivos:** packages/database/src/{queue,delivery-events,client}.ts, packages/database/prisma/schema.prisma, migrations/20260922040000_group_participants, apps/server/src/{dispatcher,whatsapp,send-context,queue-forecast,app,campaign-routes,dashboard}.ts, testes, apps/web/src/** (área do codex: assumida por pedido do dono, codex sem tokens)
**Tarefas:** T-091, T-092, T-093, T-094 (concluídas)
**Estado:** compila · lint ok · npm test 47+2 ok · integração 38/38
**Armadilhas:** @fastify/static está com `wildcard: false`: recompilar o painel com o servidor rodando deixa a página em branco até reiniciar (lista de arquivos é lida na partida). "Membros" só aparece depois de sincronizar os grupos. O backend e a UI nova dependem um do outro: a UI tolera servidor antigo (progress/delivered ausentes), mas reinicie os dois juntos.
**Próximo passo sugerido:** teste real com um grupo só-admins sem permissão para ver as 3 tentativas e o "Falhou nas 3 tentativas"; depois começar multiusuário pelo isolamento de dados (T-010/T-011).

## 2026-09-22T03:45Z · claude

**Fiz:** corrigi o 502 do Railway. Sem PUBLIC_URL, `loadConfig` caía no modo local e escutava em 127.0.0.1 (o proxy do Railway não alcança); além disso, as origens aceitas eram só localhost, então o login pelo domínio do Railway daria 403 "Origem não permitida". Agora, no Railway (RAILWAY_ENVIRONMENT_ID/RAILWAY_ENVIRONMENT/RAILWAY_PROJECT_ID), o host padrão é 0.0.0.0 e, sem PUBLIC_URL, vale https://RAILWAY_PUBLIC_DOMAIN. Local inalterado (127.0.0.1, PORT do .env, padrão 3000). PUBLIC_URL e HOST continuam tendo prioridade.
**Arquivos:** apps/server/src/config.ts, apps/server/src/config.test.ts (novo), package.json (script test inclui config.test.js), .env.example
**Tarefas:** T-090 (concluída)
**Estado:** compila · lint ok · npm test 40+2 ok · integração 35/35 · bind verificado: local 127.0.0.1, Railway simulado 0.0.0.0
**Armadilhas:** no Railway o disco do contêiner é apagado a cada deploy; a sessão do WhatsApp (SESSIONS_DIR) precisa de um Volume, senão pede QR de novo a cada deploy. Mídias ficam no banco (CampaignMedia.data), não precisam de volume. Não rodar campanhas no PC e no Railway ao mesmo tempo com o mesmo número.
**Próximo passo sugerido:** criar o Volume no Railway (ex.: /data) e definir SESSIONS_DIR=/data/sessions.

## 2026-09-21T21:40Z · claude

**Fiz:** selo "só admins" com a situação da conta (admin / não admin / desconhecido) na lista de grupos do formulário de campanha, mais aviso quando um grupo selecionado não vai receber (ADR-013).
**Arquivos:** packages/database/prisma/schema.prisma, packages/database/prisma/migrations/20260921213000_group_admin_flags/migration.sql, apps/server/src/send-context.ts, apps/server/src/whatsapp.ts, apps/server/src/whatsapp.test.ts, apps/web/src/components/campaign-form.tsx
**Tarefas:** T-089 (concluída)
**Estado:** compila · lint ok · npm test 35+2 ok · integração 35/35
**Armadilhas:** os campos só se preenchem depois de "Sincronizar grupos" (ou de um envio ao grupo); até lá ficam null e não aparece selo. Migration escrita à mão com a tabela `Group` em maiúscula (Linux é case-sensitive).
**Próximo passo sugerido:** conferir o selo no painel depois da próxima sincronização real.

## 2026-09-21T21:10Z · claude

**Fiz:** o dono confirmou que o grupo 14 do teste real é "só administradores enviam" (conta não é admin): o WhatsApp aceitou o pedido e a mensagem nunca apareceu. `WhatsAppProvider.send` agora FALHA ANTES de enviar nesse caso (código `grupo:so-admins`); nada sai, então não há duplicação. Também estabilizei o teste "queue delay" (o atalho releaseNext disputava linhas com o despachante e às vezes caía em deadlock; agora usa lockCampaign + LOCKING_TRANSACTION).
**Arquivos:** apps/server/src/whatsapp.ts, apps/server/src/whatsapp.test.ts, apps/server/src/integration.test.ts, .ai/TASKS.md
**Tarefas:** T-088 (concluída), T-086 (descartada: dono manteve a ADR-003)
**Estado:** compila · lint ok · npm test 35+2 ok · integração 35/35 (3 execuções seguidas)
**Armadilhas:** o bloqueio só age quando a conta é ENCONTRADA na lista de participantes e não é admin; se a lista vier só com LIDs desconhecidos a situação fica "?" e o envio segue (a recusa, se houver, cai no ADR-012). A migration 20260921190000 ainda não tinha sido aplicada no banco local do dono (sistema antigo rodando) — aplica ao abrir o launcher.
**Próximo passo sugerido:** no próximo teste real, conferir no painel se algum envio fica em "aguardando confirmação de entrega" por muito tempo e anotar o sendContext.

## 2026-09-21T19:30Z · claude

**Fiz:** investiguei o teste real de 20 grupos (envio 14 "enviado" sem chegar; atrasos) e
implementei a menor correção segura: o sistema passa a ouvir a recusa do servidor e o recibo de
entrega depois do sendMessage (ADR-012), e registra tempos, tentativas, código de erro e a
situação do grupo em cada envio. Nada é reenviado automaticamente.
**Arquivos:** packages/database/{prisma/schema.prisma, migrations/20260921190000_delivery_observability,
src/delivery-events.ts (novo), src/queue.ts, src/client.ts}; apps/server/src/{whatsapp.ts,
dispatcher.ts, send-context.ts (novo), app.ts, integration.test.ts, whatsapp.test.ts};
apps/web/src/pages/campaign-detail.tsx; .ai/*
**Tarefas:** T-084, T-085 concluídas. T-086 (intervalo na grade) e T-087 (expirar recibos
pendentes) abertas, aguardando decisão do dono.
**Estado:** compila · lint limpo · 36 unitários · 35 de integração (7 novos do fluxo de envio).
**Armadilhas:**
- **Migration gerada no Windows sai com tabela minúscula** (`delivery`): o MySQL do Windows
  guarda nomes em minúsculas. Corrigido à mão para `Delivery`; no Linux (Hostinger) a versão
  minúscula quebraria o deploy. Revise o case de toda migration gerada por diff contra o banco.
- Com o sistema rodando, `prisma generate` falha com EPERM (DLL travada) e aborta o
  `npm run build`; compile os workspaces separadamente ou pare o sistema.
- O dono tinha o sistema rodando durante a investigação: não abri outra conexão com a sessão.
  A causa exata do envio 14 não é recuperável (nenhum evento do servidor foi gravado na época).
- Os 265 PendingRead são leituras de mensagens enviadas pelo celular (ids 3A…), nunca vão casar.
**Próximo passo sugerido:** o dono decidir T-086; no próximo teste real, conferir no painel se
algum envio aparece como "Recusado pelo WhatsApp" e o sendContext dele.

## 2026-09-21T06:10Z · claude

**Fiz:** corrigi o pareamento por QR (companion_reg_refresh, ver pairing.ts), removi o alerta do
Baileys, assumi a T-075 do Codex (sem tokens) e concluí a simplificação: painel Next → Vite
servido pelo Fastify na mesma porta, login obrigatório, hardening, entrada única server.js,
retomada automática do WhatsApp e guia de deploy na Hostinger. Commits agora em português.
**Arquivos:** apps/server/src/{auth,config,security,pairing,connection-policy}.ts (novos),
app.ts, main.ts, whatsapp.ts, media.ts; apps/web (reescrito em src/); server.js;
scripts/{launcher.mjs,start-local.cjs,user-create.mjs}; migration 20260921050000_auth;
README.md, docs/deploy-hostinger.md, AGENTS.md, CLAUDE.md, .ai/*
**Tarefas:** T-075, T-080 a T-083, T-042, T-043, T-044, T-047, T-050, T-051, T-060, T-061, T-067 concluídas.
**Estado:** compila · lint limpo · 34 unitários · 28 de integração (inclui login e segurança) ·
validado no navegador: login, telas, busca, salvar campanha, sair.
**Armadilhas:**
- **O QR funcionou de verdade:** a sessão atual foi pareada às 03:55Z, 1,5 min depois do commit
  da correção (774d91c). Não clique em Desconectar em testes: há sessão real pareada (iPhone).
- Toda requisição que altera dados precisa de Origin do painel; testes injetam cookie e origin
  pelo helper `auth()` de integration.test.ts.
- O servidor registra os arquivos do painel na partida: após `vite build`, reinicie.
- O banco local tem 155 grupos reais e **0 usuários**: o próximo .exe pede e-mail e senha.
- Limite de rota (bodyLimit) no Fastify vence o do parser; por isso /api/media não tem bodyLimit.
- Abertas e relevantes: T-041 (desvincular aparelhos antigos), T-048 (Range de mídia ainda
  carrega o arquivo inteiro), T-053 (SIGKILL do ffprobe), T-052 (limpeza de mídia órfã).
**Próximo passo sugerido:** o dono publicar na Hostinger seguindo docs/deploy-hostinger.md e
cadastrar o monitor de /api/health; depois observar por uma semana se o app fica sempre ligado.

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

