# DECISIONS — registros de decisão arquitetural (ADR)

> Uma ADR registra **uma escolha e seu porquê**. Depois de aceita, é imutável:
> para mudar de ideia, escreva uma ADR nova que substitui a anterior (`Substitui: ADR-00X`).
>
> **Nenhum agente pode contrariar uma ADR aceita sem autorização do usuário humano.**
> ADRs com status "proposta" ainda não foram confirmadas pelo dono: são a recomendação atual, não regra.

---

## ADR-001 — O repositório é o canal de comunicação entre agentes

**Data:** 2026-09-20 · **Autor:** claude · **Status:** aceita

**Contexto.** O projeto é desenvolvido por dois agentes de IA (Claude Code e Codex CLI)
em sessões separadas, sem memória compartilhada. Sem coordenação, eles se sobrescrevem.

**Decisão.** Toda a coordenação acontece por arquivos versionados em `.ai/`, com
`AGENTS.md` como contrato normativo. Claude Code lê `CLAUDE.md`, que importa `AGENTS.md`;
Codex lê `AGENTS.md` nativamente. Locks cooperativos em `.ai/TASKS.md` evitam colisão.
`npm run ai:check` valida mecanicamente que o ritual foi cumprido.

**Consequências.** Nenhuma ferramenta externa é necessária e o histórico fica no Git.
Em troca, exige disciplina: uma sessão que não atualiza o handoff quebra a corrente.
O `ai:check` existe para tornar essa falha visível em vez de silenciosa.

**Alternativas descartadas.** Banco compartilhado ou serviço de mensagens entre agentes:
infraestrutura demais para dois agentes que já compartilham um working tree.

---

## ADR-002 — O backend permanece em TypeScript/Node

**Data:** 2026-09-20 · **Autor:** claude · **Status:** proposta (aguarda confirmação do dono)

**Contexto.** Foi levantado migrar o backend para Python ou Java.

**Decisão.** Manter TypeScript/Node em API e worker.

**Justificativa.** A dependência crítica do produto é **Baileys**, biblioteca Node que
implementa o protocolo do WhatsApp Web. Não existe equivalente maduro em Python. Em Go
existe `whatsmeow`, que é tecnicamente superior, mas trocaria a linguagem do worker sem
resolver nenhum gargalo atual — a carga é ligada a I/O e baixa em QPS, regime em que Node
é adequado. Java/Spring adicionaria peso operacional desproporcional ao tamanho do sistema.
Manter uma linguagem só preserva os tipos compartilhados entre API, worker e painel.

**Consequências.** O esforço de profissionalização vai para estrutura, validação,
testes e observabilidade — não para reescrita. `whatsmeow` fica registrado como
alternativa futura caso a estabilidade do Baileys se torne o gargalo real.

**Substitui:** nada.

---

## ADR-003 — A fila sacrifica entregas em vez de arriscar duplicatas

**Data:** 2026-09-20 · **Autor:** claude · **Status:** aceita (formaliza decisão já implementada)

**Contexto.** Não existe transação distribuída entre o PostgreSQL e o WhatsApp. Uma queda
entre o `sendMessage` e a resposta deixa o resultado genuinamente desconhecido: a mensagem
pode ter chegado ou não, e não há como descobrir pelo protocolo.

**Decisão.** A reserva `PENDING → PROCESSING` é durável e acontece **antes** da chamada
externa, sob lock da campanha. Uma entrega que falha depois da reserva **nunca** é repetida
automaticamente, e a interface não oferece "Tentar novamente". Um `PROCESSING` encontrado
no boot vira `FAILED` com aviso de resultado incerto.

**Justificativa.** Em campanhas para grupos, uma mensagem duplicada é um dano
reputacional visível e irreversível; uma mensagem faltante é recuperável pelo operador,
que confere no celular. Preferimos a falha silenciosa à duplicata ruidosa.

**Invariantes que dependem disso** (quebrar qualquer uma reintroduz duplicatas):
- Só a entrega com menor `sequence` pendente de uma campanha pode ser reservada.
- `Delivery` tem `@@unique([campaignId, sequence])` e `@@unique([campaignId, groupId, scheduledAt])`.
- O ID do job BullMQ **é** o ID da entrega, então reenfileirar é idempotente.
- O intervalo conta a partir do **fim** da tentativa anterior, inclusive após falha.
- O worker revalida estado, ordem e intervalo sob lock: um job antigo do Redis não
  contorna pausa nem encerramento.
- Redis pode ser reconstruído a partir do banco; o banco é a fonte de verdade.

**Consequências.** Perde-se a garantia de entrega. Ganha-se a garantia de não-duplicação,
que é a que importa aqui. Qualquer proposta de retry automático precisa de uma ADR nova
e de um mecanismo de deduplicação do lado do WhatsApp — que não existe.

---

## ADR-004 — Multi-tenancy por coluna `organizationId` com FKs compostas

**Data:** 2026-09-20 · **Autor:** claude · **Status:** proposta (aguarda confirmação do dono)

**Contexto.** O sistema precisa suportar várias organizações, vários usuários por
organização e vários números de WhatsApp por organização. Hoje nenhuma tabela tem escopo.

**Decisão.** Isolamento por **coluna `organizationId` em toda tabela raiz**, reforçado por
**chaves estrangeiras compostas** `(organizationId, <fk>)` que referenciam
`@@unique([organizationId, id])` do pai. O acesso passa por um cliente Prisma derivado
(`$extends`) que injeta o escopo; o import direto do cliente cru fica restrito a
`packages/database`.

**Justificativa.** As FKs compostas tornam um vínculo entre tenants **estruturalmente
impossível** no nível do banco, não apenas improvável por disciplina — é onde está o
maior ganho, e sai de graça em performance.

Row Level Security foi considerada e **rejeitada como mecanismo primário**: o Prisma não
tem hook de "antes de toda query nesta conexão", `SET LOCAL` só vale dentro de transação
(exigiria envelopar toda leitura e pagar round-trips extras), e `SET` sem `LOCAL` vaza
contexto entre requests com pooling — pior que não ter RLS. Decisivo: **o worker roda fora
de contexto de request e é cross-tenant por design** (o supervisor precisa enxergar as
sessões de todas as organizações), então justamente no componente mais crítico o RLS
precisaria de `BYPASSRLS` e deixaria de proteger.

Schema-por-tenant foi rejeitado: o Prisma não suporta bem N schemas, `migrate deploy`
viraria N aplicações com falha parcial possível, e o ganho só compensa sob requisito
regulatório de isolamento físico.

**Consequências.** Duas obrigações vêm junto, e não são opcionais:
1. Os `$queryRaw` existentes precisam de escopo explícito. `lockCampaign` passa a filtrar
   por `organizationId` e retorna zero linhas (⇒ erro) para id de outro tenant.
2. RLS pode ser adicionada **depois**, como defesa em profundidade, nas tabelas de maior
   impacto (`Delivery`, `DeliveryRead`, `CampaignMedia`), com um role `worker` `BYPASSRLS`.

---

## ADR-005 — O grupo pertence à sessão, não ao sistema

**Data:** 2026-09-20 · **Autor:** claude · **Status:** proposta (aguarda confirmação do dono)

**Contexto.** `Group.externalId` é `@unique` global. O JID de um grupo
(`1203...@g.us`) é único no WhatsApp inteiro, mas **não** identifica uma relação: dois
números diferentes podem participar do mesmo grupo.

**Decisão.** `Group` ganha `sessionId` e a constraint vira `@@unique([sessionId, externalId])`.
`externalId` passa a `NOT NULL`; grupos manuais recebem a sentinela `local:<cuid>`.

**Justificativa.** Com a constraint global, o `upsert` de `sync()` faz a segunda sessão
**sequestrar** a linha da primeira. Pior: `sync()` hoje executa
`updateMany({ where: { externalId: { not: null } }, data: { active: false } })`, que
desativa **todos** os grupos sincronizados do banco inteiro antes de reativar os que a
sessão corrente enxerga. Com duas sessões, sincronizar B desativa silenciosamente os
grupos de A e as campanhas ativas de A passam a falhar com "Grupo inativo.". Com dois
tenants, é escrita cross-tenant direta.

A sentinela em vez de `NULL` existe porque o Prisma não faz `upsert` por unique composta
contendo coluna nullable.

**Consequências.** `sync()` precisa ser escopado por sessão na mesma mudança — a migration
sozinha não corrige o `updateMany`. `recordRead` deixa de casar por
`group: { externalId }` e passa a casar por `group: { sessionId }`.

---

## ADR-006 — O rate-limit pertence ao número, não à campanha

**Data:** 2026-09-20 · **Autor:** claude · **Status:** proposta (aguarda confirmação do dono)

**Contexto.** `nextAvailableAt` e o lock `FOR UPDATE` vivem na `Campaign`. Isso é correto
enquanto existe exatamente um número conectado.

**Decisão.** `WhatsAppSession` ganha seu próprio `nextAvailableAt` e `minIntervalSeconds`.
`claimDelivery` passa a respeitar **os dois relógios**: o ritmo da campanha e o piso do
número. A ordem de locks é fixa — **sessão antes de campanha** — para não haver deadlock
entre workers.

**Justificativa.** O WhatsApp restringe o **número**, não a campanha. Com o modelo atual,
três campanhas ativas no mesmo número, cada uma com intervalo de 180 s, tomam locks
diferentes e podem chegar a um envio a cada ~60 s pelo mesmo número (se escalonadas) ou a várias mensagens em sequência limitadas só pelo limiter global (se coincidirem) — exatamente o padrão que provoca
banimento. Hoje isso está mascarado pelo limiter global `max: 1 / 1500 ms` do BullMQ, que
só funciona porque existe um único worker e um único número.

**Consequências.** O lock Redis global `campaign:worker-owner` é substituído por um
**lease por sessão no banco** (`ownerId` + `leaseUntil`), renovado periodicamente. A
limpeza de `PROCESSING` órfão sai do boot do processo e passa para o momento da aquisição
do lease, escopada por sessão — hoje ela marca como `FAILED` **toda** entrega em
`PROCESSING` do banco, o que com dois workers aborta entregas que o outro está enviando.

Topologia: **um processo com N sockets** (`Map<sessionId, WhatsAppProvider>`) e uma fila
BullMQ por sessão até cerca de 10 sessões simultâneas; acima disso, um processo por sessão
com supervisor. A fronteira de refatoração é a mesma nos dois casos, então migrar depois
é trocar o `Map` por um `fork()`, sem tocar em schema nem em `claimDelivery`.

---

## ADR-007 — Credenciais de sessão saem da árvore do projeto

**Data:** 2026-09-20 · **Autor:** claude · **Status:** proposta (aguarda confirmação do dono)

**Contexto.** `.sessions/whatsapp/creds.json` guarda, em texto claro, `noiseKey`,
`signedIdentityKey`, `advSecretKey` e `signalIdentities`. Esse conjunto **é** a sessão:
quem copia o diretório assume a conta sem QR e sem senha. O projeto está em
`C:\Users\rafad\OneDrive\...`, então esses segredos são replicados para a nuvem, para
qualquer outro PC logado na mesma conta, e permanecem no histórico de versões do OneDrive
mesmo após exclusão local. `mkdir(..., { mode: 0o700 })` não tem efeito no Windows.

**Decisão.** O diretório de sessão passa a ser configurável por variável de ambiente e o
padrão sai da árvore sincronizada (`%LOCALAPPDATA%\raf-campanhas\sessions`). No caminho
multi-sessão, as credenciais migram para `WhatsAppSession.authBlob`, cifradas em repouso.
Diretórios `-revoked-*` deixam de ser retidos indefinidamente.

**Justificativa.** `.gitignore` protege contra o Git; não protege contra o OneDrive.
A proteção por permissão de arquivo que o código tenta aplicar não existe na plataforma alvo.

**Consequências.** Requer uma variável de ambiente nova e um passo de migração manual do
diretório existente. As duas sessões revogadas presentes hoje devem ser apagadas e os
aparelhos correspondentes desvinculados pelo celular — o `logout()` está dentro de um
`catch` silencioso, então não há garantia de que foram revogadas de fato.

---

## ADR-008 — O PostgreSQL é a fila; Redis e Docker saem do projeto

**Data:** 2026-09-20 · **Autor:** claude · **Status:** aceita (decisão do dono)

**Contexto.** O ambiente local usava Docker Compose para subir PostgreSQL e Redis. O dono
passou a ter PostgreSQL 18 instalado nativamente no Windows e pediu a remoção do Docker.
Redis não tem build oficial para Windows, então tirar o Docker tira o Redis junto — e o
BullMQ depende dele.

**Decisão.** Remover `bullmq`, `ioredis` e `docker-compose.yml`. O worker passa a varrer o
PostgreSQL diretamente a cada 5 segundos. O lock `campaign:worker-owner` que vivia no
Redis vira a tabela `WorkerLease` (linha única, `ownerId` + `expiresAt`, TTL de 30 s
renovado a cada 10 s).

**Justificativa.** O BullMQ nunca foi responsável pela correção do envio. Quem garante
não-duplicação é `claimDelivery`: reserva transacional `PENDING → PROCESSING` sob
`SELECT ... FOR UPDATE` da campanha, com verificação de cabeça de fila, estado e intervalo.
O worker já revalidava tudo contra o banco, e o próprio README dizia que "Redis pode ser
reconstruído a partir do banco". Com vazão de **uma mensagem a cada 1,5 s**, Redis não
resolvia problema nenhum.

Remover elimina de uma vez: o achado A2 da auditoria (Redis sem senha exposto na LAN),
a classe de bugs de "job velho no Redis contornando pausa", e um serviço inteiro do
ambiente local.

**Consequências.**
- O piso de 1,5 s entre chamadas externas, antes no `limiter` do BullMQ, passa a ser
  explícito (`SEND_SPACING_MS`) no laço de varredura.
- A deduplicação que vinha de `jobId` passa a vir do banco: `claimDelivery` faz
  `updateMany where status = 'PENDING'` e devolve zero se outro já reservou.
- A limpeza de `PROCESSING` órfão no boot agora roda **depois** de obter o lease —
  a posse é a prova de que nenhum outro processo está enviando.
- A latência máxima para iniciar um envio devido é o intervalo de varredura (5 s),
  igual ao que já era.
- Perde-se o painel do BullMQ e o retry automático — que a ADR-003 já proibia de propósito.
- `main_db` é compartilhado, então as tabelas do projeto ficam no schema `campanhas`,
  não em `public`.

**Substitui:** a parte de infraestrutura local da ADR-001 do README original.

**Adendo (2026-09-21) — armadilha de fuso no lease.** A primeira versão do lease comparava o
vencimento em SQL bruto (`"expiresAt" < $1`). A coluna é TIMESTAMP sem fuso e o Prisma grava
UTC, mas a comparação converte a coluna pelo fuso da sessão do Postgres (America/Sao_Paulo,
UTC-3): um lease só parecia vencido 3 horas depois, e um worker morto bloqueava o sistema.
Foi observado de verdade, com o worker esperando 7 minutos por um lease já vencido.
Agora `packages/database/src/lease.ts` usa a API de modelo do Prisma, com teste de regressão
(vencimento de 31 s). **Regra: não compare datas em SQL bruto contra colunas TIMESTAMP.**
Além disso, o worker espera até 40 s por um lease órfão, porque fechar a janela do console no
Windows mata o processo sem rodar shutdown().

---

## ADR-009 — Simplificação para um processo e painel na mesma origem

**Data:** 2026-09-20 · **Autor:** codex · **Status:** aceita (decisão do dono)

**Contexto.** O produto atual separa painel Next.js, API Fastify e worker do WhatsApp em três processos e três portas. O dono autorizou simplificar para uma instalação em VPS com um único processo Node e PostgreSQL como única infraestrutura de dados/fila. A auditoria também identificou que autenticar a API antes de migrar o painel server-side quebraria as consultas do painel, pois elas não encaminham o cookie do navegador.

**Decisão.** A evolução seguirá esta ordem: (1) fundir API e despachante em `apps/server`, preservando as invariantes de fila; (2) migrar o painel para Vite + React servido pelo Fastify na mesma origem; (3) adicionar autenticação, autorização e hardening; (4) empacotar para VPS. O backend permanece TypeScript/Node. Redis não volta a fazer parte da pilha. A autenticação inicial será de instalação única, com OWNER e OPERATOR; multi-organização e múltiplas sessões continuam etapas posteriores.

**Justificativa.** Baileys é uma biblioteca Node e a aplicação já compartilha tipos TypeScript. Um processo reduz portas, chamadas HTTP internas, falhas de inicialização e custo operacional. A SPA same-origin permite cookies httpOnly sem CORS e sem duplicar lógica de sessão no servidor de renderização.

**Consequências.** O painel será migrado antes da autenticação global. A fila continuará usando PostgreSQL, `claimDelivery` e o lease; não haverá retry automático. A transição precisa preservar rotas funcionais e testes. O checkpoint `pre-simplificacao` foi criado antes da mudança.
---

## ADR-010 — O banco passa a ser MySQL 8

**Data:** 2026-09-21 · **Autor:** claude · **Status:** aceita (decisão do dono)
**Substitui:** a escolha de PostgreSQL da ADR-008. A parte "o banco é a fila, sem Redis" continua valendo.

**Contexto.** O dono desinstalou o PostgreSQL e passou a usar MySQL 8 (serviço `MySQL80`). O
sistema ficou fora do ar: o banco configurado não existia mais.

**Decisão.** Prisma com `provider = "mysql"`, banco `campanhas` em utf8mb4. O histórico de
migrations de PostgreSQL foi substituído por uma baseline única
(`20260921030000_mysql_baseline`); o histórico antigo continua no Git. Não havia dados a
migrar (o PostgreSQL já tinha sido removido e o MySQL começou vazio).

**Diferenças que exigiram código, não só configuração:**
1. **Isolamento (a mais importante).** O InnoDB usa REPEATABLE READ e congela o snapshot na
   primeira leitura da transação. Em `claimDelivery` essa leitura acontece antes do lock da
   campanha, então uma pausa confirmada durante a espera pelo lock ficava invisível e a
   entrega **saía com a campanha pausada** (violaria a ADR-003). Toda transação que chama
   `lockCampaign` usa `LOCKING_TRANSACTION` (READ COMMITTED), que reproduz a semântica que a
   fila sempre assumiu. Há teste de regressão, e ele foi verificado falhando sem a correção.
2. **Identificadores.** Aspas duplas são texto no MySQL; o SQL bruto usa crases.
3. **Tamanho de coluna.** `String` vira VARCHAR(191): mensagens, corpo da entrega e erros
   são TEXT; nome de campanha VARCHAR(200); nomes de grupo e mídia VARCHAR(255).
4. **Pacote.** `max_allowed_packet` precisa comportar o vídeo de 64 MB. O padrão do MySQL 8
   (64 MB) basta; `npm run db:check` confere, e um blob de 64 MB foi gravado e relido íntegro.
5. **Teste de integração.** Isolamento por banco descartável `campaign_test_*`, não por schema.

**Consequências.** Comparar DATETIME com NOW() em SQL bruto continua proibido (fuso da sessão).
No Linux (VPS) o MySQL diferencia maiúsculas em nomes de tabela: use sempre os nomes exatos do
schema. As ADRs propostas de multi-tenant (004–007) seguem válidas no MySQL.

---

## ADR-011 — Um processo, painel Vite na mesma origem, login obrigatório, Hostinger

**Data:** 2026-09-21 · **Autor:** claude · **Status:** aceita (decisão do dono)
**Substitui:** a parte "Next como fronteira de autenticação" das recomendações anteriores.

**Contexto.** O dono vai publicar na hospedagem de sites da Hostinger (Node.js App), que
roda um arquivo de entrada por app, entrega a porta ao processo e troca a pasta do app a
cada deploy. O painel era Next.js em outro processo e a API não tinha autenticação.

**Decisão.**
1. **Um processo** (`server.js` → `apps/server`) serve o painel compilado pelo Vite e a API
   em `/api`, na mesma porta e origem. Sem CORS, sem URL de API gravada no build.
2. **Login obrigatório, negar por padrão:** só `/api/health`, `/api/auth/login` e
   `/api/auth/setup` são públicas. Senha com scrypt (biblioteca padrão, sem binário nativo);
   cookie HttpOnly/SameSite=Lax/Secure com token aleatório, e só o hash SHA-256 no banco.
   Sem cadastro público: `ADMIN_EMAIL`/`ADMIN_PASSWORD` na primeira subida ou `user:create`.
3. **`PUBLIC_URL` define o modo:** publicado aceita a origem dele (com e sem www), usa proxy
   confiável e cookie Secure, escuta em 0.0.0.0 e não checa Host (o proxy pode mandar um nome
   interno). Local mantém a checagem de Host contra DNS rebinding.
4. **Sessão do WhatsApp fora da pasta do app** e **retomada automática** de sessão já pareada
   na subida: sem isso, cada deploy exigiria QR ou deixaria as campanhas paradas.

**Consequências.** Rodar numa hospedagem compartilhada tem um risco não verificado: se ela
desligar apps ociosos, a fila e a conexão param. Mitigação: monitor externo em /api/health;
alternativa: VPS com o mesmo `node server.js`. O limite de login é em memória (um processo).

---

## ADR-012 — "Enviado" é pedido aceito; entrega e recusa vêm do servidor depois

**Data:** 2026-09-21 · **Autor:** claude · **Status:** aceita (pedido do dono após o teste real de 20 grupos)
**Complementa:** ADR-003 (continua valendo: nada é reenviado automaticamente).

**Contexto.** No primeiro teste real, o envio 14 ficou `SENT` sem nunca aparecer no grupo.
O `sendMessage` do Baileys só escreve a mensagem no socket e devolve o id com status
`PENDING`; ele não espera o servidor. A recusa do servidor chega depois como *ack* com erro
(`messages.update`, status ERROR, código), e a entrega chega como recibo de cada participante
(`message-receipt.update`, `receiptTimestamp`). O sistema não ouvia nenhum dos dois.

**Decisão.**
1. `SENT` significa "o WhatsApp recebeu o pedido". A entrega passa a ser registrada em
   `deliveredAt` (primeiro recibo de entrega ou de leitura de qualquer participante).
2. Uma recusa do servidor transforma `SENT` em `FAILED` (`serverRejectedAt`, `errorCode`
   `servidor:<código>`). **Nunca é reenviada.** Se já houve recibo de entrega, a recusa é só
   registrada: algo que chegou ao grupo não é declarado falha.
3. Os eventos podem chegar antes de o envio ser gravado: ficam em memória e são reaplicados a
   cada ciclo por 15 min. Um reinício nessa janela perde o evento (mesma limitação das leituras).
4. Cada envio registra `attempts`, `attemptedAt` (início), `sendReturnedAt` (retorno),
   `errorCode` e `sendContext` (membro/admin/só-admins do grupo no momento do envio).
5. Zero leituras ou falta de recibo **nunca** são tratadas como falha nem disparam reenvio: o
   painel mostra "aguardando confirmação de entrega".

**Consequências.** Contrato alterado: uma entrega `SENT` pode virar `FAILED` depois de a
campanha terminar, e as métricas de falha do dia acompanham. O intervalo entre envios não foi
alterado (continua contado do fim do envio anterior; ver T-086, que depende de nova decisão).


## ADR-013 · Selo "só admins" nos grupos

**Data:** 2026-09-21 · **Status:** aceita (pedido do dono) · **Autor:** claude

`Group` ganha `adminOnly` e `isAdmin` (Boolean opcionais; null = desconhecido), gravados na
sincronização (`groupFetchAllParticipating`) e atualizados a cada envio (`groupMetadata`).
`GET /api/groups` passa a devolver os dois campos. O formulário de campanha mostra
"Só admins · você é admin ✓", "Só admins · você não é admin — não vai receber" ou
"não deu para confirmar", e avisa quando há grupos selecionados que não vão receber.
O bloqueio real continua no envio (`grupo:so-admins`, antes do sendMessage); o selo é só
informação e reflete a última sincronização.

## ADR-014 · Reenvio automático limitado, só do que comprovadamente não saiu

**Data:** 2026-09-22 · **Status:** aceita (pedido explícito do dono) · **Autor:** claude
**Altera:** ADR-003 ("falha nunca é repetida") para as falhas em que é certo que nada chegou.

**Reenvia** (volta para a fila, mesma sequência, novo `scheduledAt`):
- falha ANTES do `sendMessage` (desconectado, metadata do grupo, só-admins, grupo inativo…),
  marcada com `notSent` em `WhatsAppProvider.prepareSend`;
- recusa do servidor depois do envio (`messages.update` ERROR, ADR-012): comprova que não chegou.

**Nunca reenvia:** `sendMessage` que lançou erro, retorno sem id, processo interrompido durante
o envio (PROCESSING órfão) e "enviado sem confirmação de entrega". Nesses casos a mensagem pode
ter chegado e o WhatsApp não deduplica.

**Limite:** 3 tentativas no total (`MAX_SEND_ATTEMPTS`), esperando 5 min e depois 15 min
(`retryAt`). Esgotou: `FAILED` com "Falhou nas 3 tentativas". Recibo de entrega da mensagem
antiga chegando para um envio que aguarda reenvio cancela o reenvio (`SENT`).

**Fila:** a cabeça passa a ser o primeiro envio (por sequência) em andamento ou já vencido
(`dueOrRunning`). Como os horários planejados crescem com a sequência, para envios normais é a
mesma cabeça de antes; a diferença é que um reenvio agendado não trava os seguintes. Continua:
um envio por vez, intervalo contado do fim do anterior, reserva sob lock da campanha.

**Contrato:** `GET /api/deliveries?campaignId` ganha `wait` (`expectedAt`, `lateMinutes`,
`reason`) calculado por `forecastQueue` só na 1ª página; `group.participants`. `GET /api/campaigns`
ganha `progress` (contagem por status). `Group.participants` (Int?) gravado na sincronização e
a cada envio.


## ADR-015 · Intervalo mínimo por número de WhatsApp (aplica parte da ADR-006)

**Data:** 2026-09-22 · **Status:** aceita (pedido do dono) · **Autor:** claude

**Problema.** O intervalo vivia só em `Campaign.nextAvailableAt` e o lock era só da campanha.
Entre campanhas diferentes a única folga era `SEND_SPACING_MS` (1,5 s, em memória): duas
campanhas no mesmo número se revezavam a cada ~1,5 s, e um reinício zerava até isso.

**Decisão.** Tabela `WhatsAppAccount` (id = JID do número = `Campaign.accountJid`) com o relógio
do número: `nextAvailableAt`, `lastSendEndedAt`, `lastIntervalSeconds`. Persistida no banco.
- `claimDelivery`: trava o número (`lockAccount`: INSERT IGNORE + SELECT … FOR UPDATE) ANTES da
  campanha; só reserva se `nextAvailableAt <= agora` e `lastSendEndedAt + intervalo da campanha
  <= agora`; ao reservar, ocupa o número até `agora + intervalo` (cobre o envio em andamento).
- `finishDelivery`: mesma ordem de locks; grava o fim da tentativa (sucesso OU falha) e libera o
  número em `fim + intervalo`.
- Partida: `holdInterruptedAccounts` segura o número por um intervalo inteiro a partir do
  reinício quando há envio interrompido (não se sabe quando ele saiu).
- Despachante tenta primeiro a campanha que espera há mais tempo (`nextAvailableAt asc`).
- Simulação não usa número (`paceKey` = null): não entra no ritmo.

**Regra do intervalo entre campanhas diferentes:** vale o MAIOR entre o intervalo da campanha
que enviou por último e o da que vai enviar.

**Ordem de locks (obrigatória):** número → campanha. Nenhum código pode travar a campanha e
depois o número.

**Multiusuário:** a linha por número é o que a ADR-006 previa. Com um WhatsApp por usuário, a
chave continua sendo o número (ou passa a ser o id da sessão) e a tabela ganha o dono; claim e
finish não mudam.


## ADR-016 · Papéis SUPER_ADMIN e USER (multiusuário, Fase 1)

**Data:** 2026-09-22 · **Status:** aceita (decisão do dono) · **Autor:** claude
**Substitui:** o OWNER/OPERATOR da ADR-009. **Contexto do plano:** isolamento por `userId`, sem
organizações, um WhatsApp por USER (decisões do dono; Fases 2+ ainda não implementadas).

- `User.role` passa a enum `UserRole { SUPER_ADMIN, USER }`, padrão `USER`. Migration
  `20260922140000_user_roles`: `OWNER` → `SUPER_ADMIN`; qualquer outro valor → `USER` (o menor
  acesso); só a coluna muda (senhas, sessões e `disabledAt` intactos).
- O papel vem SEMPRE do banco, lido a cada requisição pela sessão (`resolveSession`). Nada do
  navegador decide permissão. Mudar o papel no banco vale na próxima requisição.
- `requireSuperAdmin` (auth.ts) é o preHandler das futuras rotas `/api/admin/*`: 401 sem sessão,
  403 para USER.
- Criação: primeira conta do sistema (bootstrapAdmin, inicializador, `user:create` com banco
  vazio) = SUPER_ADMIN; depois `user:create` = USER; SUPER_ADMIN só com `--super-admin` +
  confirmação digitada. `user:create` nunca altera o papel de conta existente.
- SUPER_ADMIN não verá conteúdo privado de campanhas/mensagens dos usuários (Fase 5/6).


## ADR-017 · Dono dos dados por userId (multiusuário, Fase 2)

**Data:** 2026-09-22 · **Status:** aceita (decisão do dono) · **Autor:** claude
**Substitui:** a ADR-004 (organizationId) e parte da ADR-005 (grupo por sessão → grupo por dono).

- `Group`, `Campaign` e `CampaignMedia` têm `userId` obrigatório (FK `User`, ON DELETE RESTRICT:
  conta com dados não pode ser apagada — desative com `disabledAt`).
- Os demais dados herdam o dono pela campanha: `CampaignMessage`, `CampaignSchedule`, `Delivery`,
  `DeliveryRead`. `CampaignGroup` ganha `userId` só para as chaves compostas.
- Chaves compostas fazem o BANCO recusar mistura de donos:
  `CampaignGroup(userId, campaignId) → Campaign(userId, id)`,
  `CampaignGroup(userId, groupId) → Group(userId, id)`,
  `Campaign(userId, mediaId) → CampaignMedia(userId, id)`.
- `Group.externalId` deixa de ser único global: `@@unique([userId, externalId])`.
- Migration `20260922160000_data_ownership`: dados existentes vão para o ÚNICO SUPER_ADMIN ativo.
  Com dados e zero ou mais de um SUPER_ADMIN ativo, a migration para na 1ª instrução (CHECK numa
  tabela temporária) sem alterar nada; banco vazio não exige SUPER_ADMIN.
- Dono SEMPRE vem de `request.user.id`: criação de grupo, mídia e campanha e a sincronização de
  grupos (`WhatsAppProvider.sync(ownerId)`, que só desativa grupos do próprio dono).
- **Ainda não (Fase 3):** leitura, edição e listagem continuam sem filtro por dono.
- `WhatsAppAccount` (ritmo por número, ADR-015) fica sem dono até a Fase 4: a chave é o número, e
  a linha passará a pertencer à sessão de WhatsApp do usuário.
- `Delivery` não tem userId nem FK composta para o grupo: é criada a partir de `CampaignGroup`
  (já protegido) pelo planejador.


## ADR-018 · APIs isoladas por usuário (multiusuário, Fase 3)

**Data:** 2026-09-22 · **Status:** aceita (decisão do dono) · **Autor:** claude

- Toda rota de dados usa `request.user.id` (sessão validada no servidor) como escopo. Nenhum
  `userId` do corpo, da query ou de cabeçalho é lido.
- Recurso de outro usuário responde **404 com o mesmo corpo** de um recurso inexistente
  (`NotFoundError` em security.ts). Vale para GET/PATCH/DELETE de campanha, mudança de status e
  download de mídia. Listagens simplesmente não trazem dados alheios (inclusive
  `/api/deliveries?campaignId=<de outro>`, que devolve lista vazia).
- Rotas escopadas: `GET /api/groups`, `GET /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/:id`,
  `PATCH /api/campaigns/:id/status`, `GET /api/deliveries` (e a previsão), `GET /api/dashboard`
  (`dashboardSummary(userId)`: todas as contagens pelas campanhas do usuário), `GET /api/media/:id`.
  Criação (grupo, mídia, campanha) já usava a sessão desde a ADR-017.
- SUPER_ADMIN nas rotas normais vê só os próprios dados. Visão global será `/api/admin/*` com
  `requireSuperAdmin` (ainda não existe).
- **Fora do isolamento até a Fase 4:** `/api/whatsapp/*` (conexão única global), ativação de
  campanha real (usa o número global), processos do sistema (despachante, recibos, eventos do
  servidor) e os selos de grupo gravados no envio (`prepareSend` atualiza todas as linhas do mesmo
  externalId).


## ADR-019 · Conexão de WhatsApp por usuário — modelo e caminhos (Fase 4A)

**Data:** 2026-09-22 · **Status:** aceita (decisão do dono) · **Autor:** claude
**Escopo:** só banco e caminhos. O sistema continua usando a conexão global (4B em diante).

- `WhatsAppSession`: `userId` @unique (uma conexão por usuário), `accountJid` @unique e opcional
  (vários null antes do pareamento; um número pareado pertence a um único usuário), `state`
  (último estado conhecido, só exibição), `lastConnectedAt`, `lastError`, `autoConnect`.
  FK para User com ON DELETE CASCADE. **Nenhuma credencial no banco**: creds.json e as chaves do
  Baileys continuam em arquivos; o QR nunca é persistido.
- `session-paths.ts`: `whatsappSessionDir(userId)` = `SESSIONS_DIR/users/<userId>/whatsapp`. O
  caminho usa só o id interno (cuid), validado por `^[A-Za-z0-9_-]{1,64}$`, com `path.resolve` e
  conferência de que o resultado fica dentro de `SESSIONS_DIR/users`. E-mail e nome nunca entram
  no caminho. `legacyWhatsappSessionDir()` aponta para a pasta global atual, só para a 4E
  encontrá-la — a 4A não lê, move nem apaga nada lá dentro.
- `WhatsAppAccount` (ritmo por número) **não muda**: o ritmo pertence ao número, não ao usuário.
- Nada usa ainda a nova estrutura: provider, despachante, rotas, eventos e partida seguem iguais.


## ADR-020 · WhatsAppManager e providers por usuário (Fase 4B)

**Data:** 2026-09-23 · **Status:** aceita (decisão do dono) · **Autor:** claude
**Escopo:** infraestrutura. Produção continua no provider GLOBAL legado (4C em diante).

- `WhatsAppProvider` aceita `{ ownerId, sessionDir }` (conexão de um usuário) ou uma pasta base
  (modo legado, `<base>/whatsapp`, que é o caminho de produção de hoje). Expõe `ownerId` e
  `sessionDir` só para leitura; nunca descobre o dono por estado global.
- `WhatsAppManager`: `for(userId)` (cria/devolve sempre a mesma instância), `peek`, `owners`,
  `ensureSession`, `stop`, `stopAll`, `disconnect`, `persistState`, `startAll`.
  Os caminhos saem só de `whatsappSessionDir(userId)`, então o gerenciador **não alcança** a
  sessão global legada.
- **STOP ≠ DISCONNECT:** `stop` encerra a conexão e PRESERVA a autenticação (desligar o sistema,
  desativar usuário). `disconnect` é o pedido explícito do usuário: faz logout e remove a pasta
  dele (só dela).
- `startAll`: só usuário ativo, só `autoConnect`, só quem já tem sessão pareada (nunca gera QR
  sozinho), cada um em seu próprio `try` (falha de um não impede os outros), e respeita
  `WHATSAPP_AUTO_CONNECT=0`. Sem linha em `WhatsAppSession`, ninguém é reconectado — por isso a
  sessão legada do dono não é apropriada automaticamente (migração é a 4E).
- `persistState` grava em `WhatsAppSession` apenas `state`, `accountJid`, `lastConnectedAt` e
  `lastError`. **Nunca QR, creds.json ou chaves.** Número já pareado em outra conta (unique da 4A)
  vira `lastError`, sem derrubar a partida.
- Único compartilhamento entre providers: a **versão do protocolo** (dado público), em cache de
  módulo, esquecido no logout. Socket, credenciais, QR, estado, timers e eventos nunca.


## ADR-021 · Rotas do WhatsApp por usuário e ponte da sessão legada (Fase 4C)

**Data:** 2026-09-23 · **Status:** aceita (decisão do dono) · **Autor:** claude

- `/api/whatsapp/status|connect|disconnect|sync` operam sobre a conexão de `request.user.id`,
  obtida em `WhatsAppManager.for(userId)`. Nada do cliente (corpo, query, cabeçalho, papel
  declarado) escolhe conexão. QR só existe na memória do provider daquele usuário.
- `connect` grava o ciclo de vida em `WhatsAppSession` (`persistState`); `disconnect` é logout
  explícito e remove a autenticação só daquele usuário; `sync` usa o provider e o dono de quem
  pediu. `stop`/`stopAll` (desligar o sistema) continuam preservando a autenticação.
- `main.ts` cria o `WhatsAppManager`, chama `startAll()` na partida e `stopAll()` no
  encerramento. O provider GLOBAL legado continua sendo o do despachante e dos envios reais
  (4D/4E) — nada no caminho de envio mudou.
- **Ponte temporária (`legacy-session.ts`)**: o dono comprovado da sessão global continua vendo-a
  nas rotas. Liga só com TODAS estas condições: papel SUPER_ADMIN; pasta legada com sessão
  pareada; dono inequívoco (um único SUPER_ADMIN ativo, ou `LEGACY_SESSION_OWNER` apontando para
  um); e o usuário ainda SEM pasta própria. USER comum nunca a alcança. Quando a 4E mover a
  sessão para `users/<id>/whatsapp`, a última condição deixa de valer e a ponte se desliga
  sozinha — aí o arquivo inteiro pode ser apagado.


## ADR-022 · Envio, eventos e recibos com dono inequívoco (Fase 4D)

**Data:** 2026-09-24 · **Status:** aceita (decisão do dono) · **Autor:** claude

- **Roteador de envio** (`sending-router.ts`): `Delivery → Campaign.userId → conexão daquele
  usuário`. `startDispatcher(router)` não recebe mais um provider global. Sem conexão do dono, o
  envio ESPERA: nunca sai por outro número e nunca é marcado como enviado. Não existe fallback.
- **Ponte legada:** única exceção, e só para o dono comprovado, resolvido por
  `legacySessionOwnerId` (regra única, em `legacy-session.ts`). Ambiguidade = sem envio.
  `main.ts` resolve o dono na partida e constrói o provider legado com esse `ownerId`
  (`legacySession: true`), **sem mover a pasta** — a migração continua sendo a 4E.
- **Ativação de campanha real** usa a conexão do dono da campanha, não "a conexão atual".
- **Eventos e recibos** carregam `ownerId` da conexão que os recebeu. `applyServerEvent` e
  `recordRead` exigem, além de número + grupo + id da mensagem, que a campanha e o grupo sejam
  **do mesmo dono**. Cada conexão aplica só os seus (`flushReads`/`flushDeliveryEvents` por
  entrada do roteador); `serverEvents`/`deliveredSeen` já eram por instância.
- **PendingRead** ganha `ownerId` opcional (migration 20260923040000, só coluna + índice, sem
  backfill: atribuir dono a recibo antigo seria adivinhação). null = sessão legada; ela é a
  única que também processa as linhas antigas sem dono.
- **Selo/metadata do grupo:** `send` recebe o `groupId` da entrega e atualiza só aquela linha.
- **Pacing intacto** (ADR-015): um envio por vez no sistema, relógio por número persistido.
  Paralelismo entre números continua sendo Fase 5.


## ADR-023 · Auditoria de segurança de ponta a ponta (2026-09-24)

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

**Corrigido:**
- **IP forjável (alto):** `trustProxy: true` fazia o Fastify aceitar o X-Forwarded-For do próprio
  cliente; o limite de tentativas de login por IP podia ser contornado trocando o cabeçalho.
  Agora só proxies da rede interna (`TRUSTED_PROXIES = 'loopback, uniquelocal'`). `TRUST_PROXY=1`
  passa a significar isso; `0` desliga; outro valor é lista explícita.
- **Sessão sem prazo final:** validade deslizante renovava para sempre. Teto absoluto de 30 dias
  desde o login (`SESSION_MAX_AGE_MS`); renovação nunca passa do teto; sessões vencidas são
  apagadas a cada 6 h (antes só no login).
- **Memória do limitador de login:** chaves por e-mail cresciam sem limite; teto de 10 mil com
  descarte amortizado.
- **Vazamento em mensagens de erro:** erros do sistema (caminhos, ENOENT/EACCES, node_modules)
  agora viram a mensagem genérica.
- **Cabeçalhos:** `Cross-Origin-Opener-Policy` e `Cross-Origin-Resource-Policy: same-origin`.
- **ffprobe travado (T-053):** SIGKILL 2 s depois do SIGTERM.

**Verificado sem problema:** SQL sempre parametrizado; nenhum `innerHTML`/`eval` no painel;
cookie HttpOnly + SameSite=Lax + Secure; token de 32 bytes com hash no banco; scrypt com sal e
tempo constante; CSRF por Origin obrigatório; isolamento por dono (ADR-018/022); upload validado
por conteúdo (sharp/ffprobe), só JPEG/PNG/MP4; nenhum segredo versionado no Git.

**Risco aceito:** `deepmerge-ts` < 8 (dependência interna do CLI do Prisma). Só roda na
ferramenta de migrations, com a nossa configuração; nenhuma entrada de usuário chega lá. A
correção automática rebaixaria o Prisma para 6.12. Rever quando o Prisma atualizar (T-049).
**Pendente:** mídia inteira em memória no download (T-048); mídia órfã (T-052).
