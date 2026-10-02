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


## ADR-024 · Migração da sessão global para o dono (Fases 4E/4F)

**Data:** 2026-09-24 · **Status:** aceita (decisão do dono) · **Autor:** claude · **Branch:** dev

- `migrateLegacySession` roda na partida, ANTES de qualquer conexão: `SESSIONS_DIR/whatsapp` →
  `SESSIONS_DIR/users/<dono>/whatsapp` por **rename atômico** (nunca cópia: dezenas de milhares
  de arquivos). Cria `WhatsAppSession` do dono com `autoConnect` e grava
  `users/<dono>/migracao-sessao-legada.json` (de, para, quando).
- Dono pela MESMA regra da ponte (`legacyOwnerCandidate`). Dono ambíguo, pasta do dono já
  existente (conflito) ou falha do sistema operacional: **nada se move**, a sessão segue na pasta
  antiga e a ponte continua valendo. Pasta vazia criada por uma tentativa falha é removida.
- Idempotente: depois de migrar não há sessão legada; as partidas seguintes não fazem nada.
- `WHATSAPP_MIGRATE_LEGACY=0` desliga. Reversão: `npm run whatsapp:reverter-migracao` (sistema
  fechado), outro rename.
- Após a migração a ponte se desliga sozinha; o dono reconecta pelo `WhatsAppManager` sem QR e
  envia pela própria conexão (teste de ponta a ponta).


## ADR-025 · Envios em paralelo entre números (Fase 5)

**Data:** 2026-09-24 · **Status:** aceita (decisão do dono) · **Autor:** claude · **Branch:** dev

- O despachante agrupa os envios vencidos em **faixas** (`laneOf`): uma por número de WhatsApp
  (`numero:<accountJid>`) e uma para a simulação. Dentro de uma faixa: um envio por vez, com a
  folga `SEND_SPACING_MS` daquela faixa. Faixas diferentes andam em paralelo.
- A rodada (scan) só entrega lotes às faixas LIVRES e não espera por elas (`busyLanes`): um
  número lento nunca segura os outros. Uma faixa ocupada não recebe outro lote.
- O intervalo continua garantido pelo banco (ADR-015): trava do número antes da campanha na
  reserva e na conclusão. Faixas diferentes nunca disputam a mesma trava de número.
- `stop()` espera os envios em andamento de todas as faixas (até 30 s); cada faixa confere
  `stopping` antes de iniciar um envio.
- `TRUSTED_PROXIES` inclui `100.64.0.0/10` (borda do Railway); nenhum cliente da internet chega
  por essa faixa.


## ADR-026 · Design system, telas e reuso de campanha (branch dev)

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- **Design system** em `apps/web/src/design/`: primitivos (Button, Card, Badge, Field, Stat,
  Alert, EmptyState, Skeleton, ScrollArea, Page…), ícones lucide-react com nomes semânticos
  (nunca setas de texto), formatos (hora, data, tamanho, cor de destaque) e dois utilitários de
  interação: `ConfirmProvider`/`useConfirm` (substitui `confirm()` do navegador) e
  `useInfiniteList`/`LoadMoreSentinel` (rolagem infinita por cursor). Cantos sempre 5–6 px
  (`tailwind.config.ts`: `DEFAULT/md 5px, lg/xl/2xl 6px`); `rounded-full` só em pontos de status.
- **Layout de app:** `main.tsx` fixa o menu e faz o conteúdo ocupar `h-dvh` menos o menu; cada
  tela decide o que rola (`ScrollArea`, barra invisível) em vez do documento. Telas menos usadas
  (`React.lazy`) carregam sob demanda.
- **Início** cabe na tela em 1366×768 sem rolar o documento: métricas em uma faixa, próximo
  envio + gráfico dos últimos 7 dias lado a lado, "em andamento" e "atividade recente" cada um
  com a própria rolagem.
- **Campanhas:** cartões em grade com rolagem infinita (cursor por `createdAt`), filtro por
  situação e busca por nome (parâmetros `status`/`q` da API); mídia como miniatura pequena; a
  faixa lateral do cartão usa a cor predominante da imagem (`accent()`, contraste garantido).
  Grupos do formulário em duas colunas.
- **Editar/Reagendar/Usar de novo** (`lib/campaign-ops.ts`, único lugar com a regra, usado pela
  lista e pelo detalhe): rascunho edita; ativa/pausada "Reagendar" chama
  `duplicate {reschedule:true}` (cancela os envios pendentes da original na mesma transação e
  abre uma cópia em rascunho); concluída/cancelada "Usar de novo" só copia. Excluir sempre passa
  por `useConfirm`.
- **Painel do SUPER_ADMIN** (`pages/admin.tsx` + `admin-routes.ts`): lista em grade de colunas
  fixas (alinhada mesmo sem botões na própria conta), cria conta, ativa/desativa, troca papel,
  redefine senha — nunca mostra QR, senha nem conteúdo de campanha.
- `railway.json`: `healthcheckPath /api/health`, restart automático, uma instância.


## ADR-028 · Piso de 3 minutos entre grupos, garantido no banco (branch dev)

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- Delays entre mensagens nunca podem ficar abaixo de 3 minutos (risco de bloqueio do número pelo
  WhatsApp). A API já recusava `intervalSeconds < 180`; isso não bastava — campanhas gravadas
  ANTES dessa validação, ou qualquer escrita direta no banco, escapavam do piso.
- `MIN_INTERVAL_SECONDS = 180` e `effectiveInterval(intervalSeconds)` em
  `packages/database/src/queue.ts`: usados em `claimDelivery`, `finishDelivery` e
  `holdInterruptedAccounts` — o piso vale mesmo que `Campaign.intervalSeconds` esteja menor.
  `intervalFloorSeconds()` só aceita `SEND_INTERVAL_FLOOR_SECONDS` (piso mais baixo, em segundos)
  quando `CAMPAIGN_TEST_DATABASE` está definido — nunca em produção.
- Migration `20260924180000_min_interval` levanta para 180 s qualquer `Campaign.intervalSeconds`
  gravado abaixo disso; nada mais muda.
- Formulário: `min={3}` no campo com aviso explícito; mensagem de erro da API atualizada.


## ADR-029 · Marcar todos os membros do grupo (@todos oculto)

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- Campo `Campaign.mentionAll` (boolean, padrão `false`). Quando ligado, todo envio dessa campanha
  leva o array `mentions` do Baileys com o id de cada participante do grupo, EXCETO a própria
  conta (`mentionTargets` em `send-context.ts`, por número ou LID). O texto da mensagem não muda
  — é a marcação "oculta" do WhatsApp: cada participante recebe notificação de menção sem o `@`
  aparecer escrito. Vale para texto, imagem e vídeo.
- `mentionAll` viaja com a campanha: some da campanha usada de novo (`duplicate`), é validado
  como booleano estrito na API e passado do despachante ao conector a cada envio
  (`{ mentionAll: delivery.campaign.mentionAll }`), nunca lido de outro lugar.
- Interface: checkbox própria no formulário ("Marcar todos os membros (@todos)", com o aviso de
  que o texto não muda) e selo discreto na lista e no detalhe da campanha quando ligado.


## ADR-030 · Tentar de novo um envio com falha

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- Duas rotas novas em `campaign-routes.ts`: `POST /deliveries/:id/retry` (um envio) e
  `POST /campaigns/:id/retry-failed` (todas as falhas seguras de uma campanha de uma vez).
  Reabrem o `FAILED` para `PENDING` com `scheduledAt = agora`; o piso de 3 min e o relógio do
  número em `claimDelivery` decidem quando ele realmente sai — "agora" nunca fura o ritmo.
  Campanha `COMPLETED` volta a `ACTIVE` para o despachante voltar a olhar para ela; `CANCELLED`
  nunca reabre por aqui (o caminho ali é "usar de novo").
- **Falha "certa"** (nada saiu — ADR-014) tenta de novo direto. **Falha "incerta"** (pode ter
  chegado) exige `{ confirmUncertain: true }` explícito, senão a rota responde 409: evita duplicar
  um envio que talvez já tenha chegado ao grupo. `isUncertainFailure` (`send-context.ts`) é a
  ÚNICA fonte dessa classificação — a palavra "incerto" na mensagem de erro, sem uma segunda
  marca (coluna) para não correr o risco de as duas ficarem fora de sincronia.
- O lote por campanha nunca inclui falhas incertas: cada uma exige confirmação própria.
- Interface: botão "Tentar de novo" por envio com falha e "Tentar de novo as falhas" em lote no
  detalhe da campanha; falha incerta pede confirmação com aviso do risco de duplicar.


## ADR-031 · Painel do administrador com métricas do sistema inteiro

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- `GET /api/admin/overview` (`admin-overview.ts`): contas (total/ativas/admins), campanhas por
  situação, envios/entregas/falhas de hoje, fila agora, últimos 7 dias (enviados e falhas por
  dia), os 5 códigos de erro mais comuns dos últimos 7 dias, WhatsApp conectados AGORA (memória
  do processo via `manager.owners()`/`peek()`, não só o último estado gravado no banco — que pode
  estar defasado), posse do despachante (`WorkerLease`) e uptime/memória do processo Node. Só
  números agregados: nenhuma rota de admin retorna nome de grupo, campanha ou mensagem.
  `prisma.$transaction(async tx => { await Promise.all([...]) })`, nunca a forma em array — com
  13 consultas o TypeScript perde a inferência de tipo por tupla nessa versão do Prisma.
- Duas ações por conta, separadas de "desativar" (que também pausa campanhas e derruba sessões):
  `POST /admin/users/:id/logout` (só encerra as sessões web) e
  `POST /admin/users/:id/whatsapp/stop` (só derruba a conexão, preservando a autenticação — a
  pessoa reconecta sem escanear o QR de novo).
- Tela redesenhada: cartões de métrica, gráfico dos últimos 7 dias, status do despachante e do
  processo, badges de erro, busca por nome/e-mail e filtro por situação/papel na lista de contas.


## ADR-032 · Conversão automática de vídeo para MP4 H.264

**Data:** 2026-09-24 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- O WhatsApp só toca bem MP4 com vídeo H.264 e áudio AAC. O celular grava em MOV e, no
  iPhone, em HEVC ("Alta eficiência") — antes o sistema só recusava ("Use MP4 com vídeo H.264").
- `apps/server/src/video-convert.ts`: aceita MP4, MOV, WebM, MKV, 3GP, M4V, AVI e MPEG até
  **200 MB**. MP4 H.264/AAC que já passa na validação vai **intacto**, byte a byte. Todo o resto
  é convertido pelo ffmpeg (`@ffmpeg-installer/ffmpeg`: binário pronto, sem script de
  instalação, que o npm 11 bloquearia): H.264 high, `yuv420p` (8 bits), lado maior até 1280 px,
  AAC 128 kbps estéreo, `+faststart`. O resultado ainda precisa caber em 64 MB e passa pela
  mesma validação de sempre (`validateMedia`). Nome vira `.mp4`; a resposta de `POST /api/media`
  ganhou o campo `converted` (aditivo).
- Uma conversão por vez (fila em memória): converter usa a CPU inteira e o despachante não pode
  ficar sem fôlego no meio de uma campanha. Limite de 10 min por conversão.
- O pacote é carregado sob demanda: sem ele instalado, o sistema liga normalmente, MP4 H.264
  segue aceito e só a conversão responde com o aviso para rodar `npm install`.
- O inicializador (`scripts/launcher.mjs`) agora roda `npm install` quando o
  `package-lock.json` mudou desde a última instalação (`.runtime/deps-stamp`). Falhou (sem
  internet)? Avisa e liga o sistema mesmo assim; tenta de novo na próxima partida.


## ADR-033 · Estado do WhatsApp gravado a cada troca; painel servido sem reiniciar; rolagem

**Data:** 2026-09-24 · **Status:** aceita (bugs achados na revisão) · **Autor:** claude · **Branch:** dev

- **Estado do WhatsApp:** só era gravado no pedido de conectar. A produção ficou com
  "connecting" e sem número desde a partida, e a trava "um número pertence a uma única conta"
  (ADR-019, `accountJid` único) nunca era conferida. Agora o provider avisa a cada troca de
  estado (`onStateChange`) e o `WhatsAppManager` grava em fila (`queuePersist`, uma gravação
  por vez por usuário, sempre com o estado mais recente). Número já de outra conta: a conexão
  duplicada é **encerrada sem logout** e a conta fica com o aviso (antes só era registrado).
  `stop()` também passa a marcar "desconectado" em memória.
- **Painel:** `@fastify/static` com `wildcard: true` (procura o arquivo a cada pedido); antes a
  lista era lida na partida e recompilar com o sistema ligado deixava o painel em branco até
  reiniciar. `/assets/*` inexistente responde 404 (antes, o index.html fingindo ser o .js). Aba
  aberta durante uma atualização recarrega sozinha uma vez (`main.tsx`, `vite:preloadError` e
  falha de `lazy`), com trava de 30 s contra laço.
- **Rolagem:** telas com colunas (Início, detalhe da campanha) limitam a linha da grade à altura
  da tela (`lg:grid-rows-[minmax(0,1fr)]`) para cada coluna rolar por dentro — antes a coluna
  crescia e a parte de baixo (ex.: a imagem da campanha) era cortada. `Page scroll` para telas
  de seções empilhadas (Administração). No celular toda página cresce e rola inteira
  (`min-h-full lg:h-full`). A rolagem infinita observa a área que de fato rola.

---

## ADR-034 · Desempenho e proteções para VPS pequena; troca de tela instantânea

**Data:** 2026-09-27 · **Status:** aceita (pedido do dono: sistema rápido e pronto para uma VPS fraca) · **Autor:** claude · **Branch:** dev

Medição: a API responde em 2–20 ms mesmo com dados. A lentidão ao trocar de tela era do painel:
cada tela era baixada só no clique (React.lazy), e depois esperava os dados com esqueleto.

- **Painel:** `page()` em `main.tsx` ganhou `preload()`. Depois do login, com o navegador
  ocioso, todas as telas são baixadas; uma tela já baixada abre direto, sem Suspense. O
  "Carregando…" só aparece se demorar mais de 300 ms. `lib/cache.ts` (`screenCache`) guarda a
  última resposta de cada tela (`usePolling` e `useInfiniteList` com `cacheKey`): voltar a uma
  tela mostra o que ela tinha na hora e atualiza por trás. O cache é apagado ao sair ou trocar
  de conta (dados de um usuário nunca aparecem para outro). Resultado medido: troca de tela de
  1 a 90 ms, e revisita instantânea.
- **Estáticos pré-comprimidos:** `scripts/compress-dist.mjs` roda no build do web e grava
  `.br`/`.gz` com compressão máxima; `@fastify/static` com `preCompressed: true` entrega o
  arquivo pronto (`Vary: Accept-Encoding`). Assim o painel cai de 376 KB para 108 KB, sem custo
  de CPU por pedido. Não ligar compressão no proxy (Caddy).
- **Login antes do corpo:** a sessão agora é conferida no `onRequest`, antes de ler o corpo.
  Antes era `preHandler`: um POST de 200 MB sem login era lido inteiro na memória antes do 401.
- **Limites (em memória, processo único):**
  - API por IP: 300 pedidos de uma vez, repondo 5 por segundo (`rate-limit.ts`, 429 com
    `Retry-After`); `/api/health` fica de fora.
  - Senha (scrypt, ~32 MB cada): no máximo 2 ao mesmo tempo e 32 na fila, depois 503
    (`Gate`/`passwordGate` em `auth.ts`).
  - Troca da própria senha: 5 erros da senha atual a cada 15 min por conta.
  - Uploads: no máximo 2 ao mesmo tempo, recusados antes de ler o corpo.
  - `requestTimeout` de 15 min e `maxConnections` de 1000.
- **Vídeo (segurança):** o ffmpeg não adivinha mais o formato. O contêiner é detectado pela
  assinatura dos bytes (`containerOf`: mov, matroska, avi, mpeg; qualquer outro é recusado),
  passado com `-f`, e com `-protocol_whitelist file`. Antes, uma playlist HLS ou concat
  disfarçada de vídeo fazia o ffmpeg ler arquivos do servidor (.env, sessões) ou a rede.
- **Baileys:** `shouldSyncHistoryMessage: () => false` (não processa o histórico ao conectar) e
  `cachedGroupMetadata` com os participantes que `prepareSend` acabou de buscar (60 s). Antes
  eram duas consultas iguais por envio; o cache é a recomendação do próprio Baileys.
- **Início:** saíram três contagens que nenhuma tela usava (`sent`, `failed`, `readsPrevious`).
  O detalhe da campanha faz as consultas em paralelo. sharp sem cache de imagens.
- **Moldura do painel:** `.scroll-area` com `position: relative` e a moldura com
  `overflow-hidden`. Rótulos `sr-only` (absolutos) escapavam da área de rolagem, esticavam o
  documento, e o menu do topo sumia ao rolar a Administração.
- **Não feito, de propósito:** `npm audit fix` para `deepmerge-ts` rebaixaria o Prisma CLI para
  6.12 (o client é 6.19). A falha é de estouro de pilha ao mesclar objetos recursivos, só no
  carregamento de configuração do CLI, que lê arquivo confiável. Fica registrado em T-049.

Guia de instalação: `docs/deploy-vps.md` (MySQL com 128 MB de buffer, swap, systemd,
Caddy, firewall, backup).

---

## ADR-035 · Sincronização automática de grupos, piso de 2 min e "Atrasado" preciso

**Data:** 2026-09-28 · **Status:** aceita (pedido do dono) · **Autor:** claude · **Branch:** dev

- **Piso de 2 minutos** (altera a ADR-028 a pedido explícito do dono): `MIN_INTERVAL_SECONDS =
  120`, padrão da API e do formulário em 2 min e padrão da coluna em 120 (migration
  `20260928000000_min_interval_2min`, só o `DEFAULT`). Campanhas existentes mantêm o intervalo
  escolhido. O relógio por número (ADR-006) continua valendo: o intervalo conta do fim do
  envio anterior do NÚMERO, mesmo que tenha sido de outra campanha.
- **"Atrasado" preciso** (`queue-forecast.ts`): antes era qualquer pendente cuja previsão
  passava do horário planejado. Como o intervalo conta do fim do envio anterior, cada envio
  empurra os seguintes alguns segundos, e uma campanha recém-iniciada aparecia inteira como
  "Atrasado". Agora só o PRÓXIMO da fila pode estar atrasado: quando já podia sair (horário
  planejado e intervalo do número cumpridos) e passou 1 min (`LATE_GRACE_MS`) sem sair — ex.:
  WhatsApp desconectado. Os seguintes mostram só a previsão ("deve sair ~HH:MM").
- **Primeiro envio na hora:** conferido na produção, o 1º envio já saía de 1 a 4 s depois do
  horário (a espera só existe se o NÚMERO enviou há menos de um intervalo). Ao iniciar ou retomar,
  `wakeDispatcher()` antecipa a varredura da fila, sem esperar até 5 s. As regras de claim não
  mudaram.
- **Grupos sincronizados sozinhos:** `WhatsAppManager.autoSyncOnConnect`. Na passagem para
  "conectado", sincroniza depois de 3 s, a não ser que já tenha sincronizado há menos de 10 min.
  `syncGroups` junta pedidos simultâneos. O pedido manual até 30 s depois do último recebe 429
  com aviso de quanto esperar (limite suave do botão, que também mostra a contagem). O status de
  `/api/whatsapp/status` traz `groupsSync` (`running`, `auto`, `at`, `count`, `error`), e a tela
  avisa quando termina.
- **Interface:**
  - Simulação fora da tela; o servidor ainda aceita `provider: 'simulator'`, que os testes usam.
  - "Quando enviar" em `Segmented`.
  - "Modelo da mensagem" recolhível no detalhe (miniatura e começo do texto; aberto mostra a
    mensagem completa).
  - Menu no nome do usuário (`Menu` com `trigger`/`header`).
  - Excluir só no cartão da lista.
  - Lista vazia sem botão duplicado (`EmptyState` com `hint`).

---

## ADR-036 · Sessão do WhatsApp resistente a quedas; nunca desiste sozinha

**Data:** 2026-09-28 · **Status:** aceita (pedido do dono: sistema confiável, resistente a quedas de conexão) · **Autor:** claude · **Branch:** dev

- **Gravação da credencial à prova de queda** (`auth-state.ts`, substitui `useMultiFileAuthState`
  do Baileys nos mesmos arquivos, sem migração): grava num arquivo temporário e troca pelo
  definitivo (`rename`), com `creds.json.bak` e fsync no arquivo principal. Antes, o processo
  encerrado no meio de uma gravação (janela fechada, queda de luz, atualização) deixava o
  `creds.json` corrompido; a próxima leitura virava sessão nova e o WhatsApp pedia QR do zero,
  **apagando o pareamento anterior na gravação seguinte**. Agora um arquivo ilegível cai para a
  cópia de segurança antes de desistir, e o motivo fica no log.
- **Nunca desiste de reconectar sozinho:** removido o teto de 6 tentativas
  (`MAX_RETRIES`/`connection-policy.ts`). O intervalo dobra a cada queda (1 s, 2 s, 4 s…) até um
  teto de 1 min e continua tentando indefinidamente. Antes, ~1 min de instabilidade de rede
  (6 tentativas) fazia a conexão desistir e esperar alguém clicar em Conectar de novo — no
  servidor, ninguém está olhando a tela.
- **A sessão só é apagada quando é logout de verdade** (código 401 do WhatsApp). O código 500,
  que o Baileys usa para qualquer erro de fluxo sem código conhecido (inclusive instabilidade
  passageira do servidor do WhatsApp), **não apaga mais a sessão** — antes cada 500 forçava ler o
  QR de novo. `multideviceMismatch`, `connectionReplaced` e `forbidden` param a conexão com aviso,
  mas também preservam a sessão.
- **Reconexão automática nunca gera QR para ninguém ver:** `connect({ interactive: false })` na
  partida e no `startAll` do gerenciador. Se o WhatsApp pedir QR numa reconexão automática (sessão
  não reconhecida), a conexão para com um aviso claro em vez de ficar com um QR que ninguém vai
  escanear. `connect()` sem argumento (clique em "Conectar" no painel) continua interativo.
- **Encerramento correto em todo jeito de fechar o processo:** `SIGINT`, `SIGTERM`, `SIGHUP`
  (fechar a janela no Windows) e `SIGBREAK`, todos chamando o mesmo `shutdown()` — antes só
  `SIGINT`/`SIGTERM` eram tratados. Espera a gravação da credencial terminar antes de sair
  (`stop()` e no logout/apagar sessão); um `setTimeout` de segurança força a saída se algo travar
  (4,5 s no `SIGHUP`, que o Windows só dá ~5 s antes de matar o processo; 35 s nos outros, cobrindo
  os até 30 s que o despachante espera pelos envios em andamento).
- **Aviso de sessão que não sobrevive a um deploy:** no Railway sem Volume configurado (ou sem
  `SESSIONS_DIR` apontando para dentro dele), `sessionsPersistent()` volta `false`; o log na
  partida e um aviso na tela do WhatsApp (`ephemeralSession`) explicam que cada deploy vai pedir
  QR de novo, e como resolver (Volume + o sistema usa `RAILWAY_VOLUME_MOUNT_PATH/sessions`
  sozinho se `SESSIONS_DIR` não estiver definida).
- **Baileys:** chaves de sessão em memória na frente dos arquivos (`makeCacheableSignalKeyStore`,
  recomendação do próprio Baileys) — menos leitura de disco por mensagem.

Nada disto migra, renomeia ou apaga uma sessão pareada existente: o formato dos arquivos é o
mesmo do `useMultiFileAuthState`, e uma sessão já conectada continua valendo sem qualquer ação.

---

## ADR-036 · Sessão do WhatsApp à prova de queda, de reinício e de deploy

**Data:** 2026-09-28 · **Status:** aceita (dono: "a sessão precisa ser mantida o máximo possível") · **Autor:** claude · **Branch:** dev

Sintoma: depois de reinícios e deploys, o WhatsApp voltava pedindo QR ("O QR Code expirou sem ser
lido"). Causas encontradas:

1. **Credencial virava uma identidade nova em silêncio.** O `useMultiFileAuthState` do Baileys
   faz `lerCreds() || novaCredencial()` e grava sem ser atômico. O processo encerrado no meio de
   uma gravação (janela fechada, PC desligado, reinício por atualização) deixava o
   `creds.json` pela metade. Na partida seguinte nascia uma identidade nova, o WhatsApp mandava QR
   e a gravação seguinte apagava o pareamento de vez.
   **Correção:** `auth-state.ts` (`useDurableAuthState`), com os mesmos nomes e formato de
   arquivo (a sessão atual continua valendo, sem migração):
   - gravação atômica (temporário + rename, com nova tentativa se o Windows segurar o arquivo);
   - `creds.json` com fsync e cópia `creds.json.bak`, restaurada se o principal estiver ilegível;
   - ilegível e sem cópia: o arquivo é guardado à parte (`creds.json.ilegivel-<ts>`), nunca
     sobrescrito;
   - `makeCacheableSignalKeyStore` na frente dos arquivos: menos leitura de disco.
2. **O código 500 apagava a sessão.** É o código genérico do Baileys para erro de fluxo sem código
   (`getErrorCodeFromStreamError`), inclusive instabilidade passageira do WhatsApp. Agora só o
   **401** (aparelho removido no celular) apaga. O 500 reconecta; o 411, o 440 e o 403 param sem
   apagar.
3. **Desistia depois de ~1 min sem rede** (6 tentativas). Agora tenta para sempre, espaçando
   1 s, 2 s, 4 s… até **uma tentativa por minuto** (sem martelar o WhatsApp). Depois de algumas
   tentativas a tela explica a espera, como aviso e não como erro. A falha ao abrir (sem internet
   na partida) também entra nesse ciclo.
4. **QR numa reconexão automática.** Com sessão pareada, um QR significa que o WhatsApp não
   reconhece mais o aparelho. Antes o sistema gerava QRs para ninguém até o "QR expirou". Agora
   só `connect({ interactive: true })`, o clique em Conectar, mostra QR. Na partida e nas
   reconexões, a conexão para na hora com o motivo.
5. **Encerramento.** Fechar a janela no Windows (SIGHUP) e Ctrl+Break (SIGBREAK) também encerram
   de forma limpa. `stop()` espera a gravação da credencial, e a saída é forçada em 4,5 s
   (janela) ou 35 s (serviço) se algo travar.
6. **Railway sem Volume.** O disco do contêiner some a cada deploy. Com Volume, o padrão das
   sessões passa a ser `$RAILWAY_VOLUME_MOUNT_PATH/sessions` sem configurar nada. Sem Volume, o
   log e a tela do WhatsApp avisam (`ephemeralSession` no status).

Fora do nosso controle (limites do WhatsApp): o celular sem internet por ~14 dias desconecta os
aparelhos vinculados; há um limite de 4 aparelhos vinculados por número; remover o aparelho no
celular sempre exige ler o QR de novo. Dois processos com a MESMA pasta de sessão derrubam um ao
outro (440). A posse do despachante já impede um segundo processo no mesmo banco de conectar.

**Complemento (2026-09-28, mesma ADR):** uma sessão paralela (branch
`claude/compassionate-hawking-lkw3ee`, não mesclada) atacou o mesmo problema. Dela vieram, por
cima desta implementação:
- `start-local.cjs` e `scripts/launcher.mjs` matavam o servidor na hora no Ctrl+C. No Windows isso
  é encerramento forçado no meio da gravação da sessão, e era mais uma causa do QR. Agora esperam o
  servidor sair sozinho e só forçam depois de 40 s. SIGTERM de gerenciador de serviço é repassado.
- `session-lock.ts`: uma pasta de sessão, um processo (`<pasta>.lock` com pid, máquina e um
  sinal de vida por minuto). Um segundo sistema com a mesma pasta, como produção e dev sem
  `SESSIONS_DIR` próprio, não abre uma segunda conexão com as mesmas credenciais: fica tentando a
  cada 30 s, com aviso na tela. A trava de um processo morto cai na hora nesta máquina; em outra
  máquina, em 3 min.
- Correção de um teste instável: o `attempts` sobe já na reserva.
O resto daquela branch duplica esta ADR (armazenamento atômico, regras de queda) e ficou de fora.

---

## ADR-037 · Falha fechada na posse da fila e na confirmação da sessão

**Data:** 2026-09-29 · **Status:** aceita (revisão de robustez aprovada pelo dono) · **Autor:** codex · **Branch:** hardening-20260928

Sem alterar a ordem nem o intervalo dos envios, uma perda do lease do despachante agora encerra o
processo com erro após liberar seus recursos. A resposta existente de `/api/health` ganhou o
campo `dispatcher` e retorna 503 se a fila não estiver ativa; o monitor não deve interpretar uma
API disponível como envio saudável. Uma falha na partida também libera o lease obtido.

Retentativas concorrentes do mesmo envio são serializadas e verificam novamente o estado sob
transação; rodadas distintas do mesmo grupo mantêm seu `scheduledAt` original. Isso impede que
uma retentativa crie duas posições na fila ou troque a identidade de uma rodada. A sessão do
WhatsApp usa trava atômica de diretório com heartbeat, mantida até terminar a gravação das
credenciais. Um segundo processo não pode abrir a mesma pasta de sessão em paralelo.

Ao sair da conta no painel, o cache só é apagado após confirmação do servidor; uma falha na
requisição mantém o estado e apresenta erro. Arquivos de mídia autenticados retornam
`Cache-Control: private, no-store`, inclusive miniaturas e respostas parciais.

Não houve migration nesta revisão. A versão de `deepmerge-ts` transitiva do Prisma permanece como
risco aceito nas ADR-023/034; substituí-la por override de versão principal requer decisão
separada. Eventos de entrega/recusa recebidos antes da gravação do envio ainda aguardam uma
migration aditiva para persistência, dependente de autorização explícita para alterar o banco.

---

## ADR-038 · Animações curtas e discretas no design system

**Data:** 2026-09-29 · **Status:** aceita · **Autor:** codex (trabalho de 2026-09-28, validado e commitado por claude) · **Branch:** dev

Três animações no `tailwind.config.ts`: `fade-in` (200 ms), `pop-in` (150 ms) e `overlay-in`
(150 ms). Ficam no núcleo do design system (`Page`, `Alert`, listas do `Select` e do `Menu`,
diálogo de confirmação), então uma tela nova já nasce com elas. O `Page` anima só ao trocar de
tela, nunca a cada atualização automática dos dados. Botões com `active:scale` (retorno leve ao
clicar) e selos com `transition-colors` (trocam de cor em vez de piscar). Com "reduzir movimento"
ligado no sistema operacional, nada anima (`prefers-reduced-motion` em `styles.css`). Detalhes em
`docs/design-system.md`.

---

## ADR-039 · @todos nativo do WhatsApp, com a marcação oculta como reserva

**Data:** 2026-09-29 · **Status:** aceita, falta validar num grupo real (T-127) · **Autor:** claude · **Branch:** dev

A opção "Marcar todos" mandava uma menção oculta de cada participante (ADR-029): notificava todos,
mas nada aparecia no texto. O dono queria o @todos do celular (digitar "@" e tocar em "todos"),
destacado.

- **Formato:** o @todos não lista ninguém. Vai um marcador no texto e `contextInfo.nonJidMentions
  = 1` (campo 70 do ContextInfo). É o formato que o fork `@itsliaaa/baileys` usa no `mentionAll`.
  O Baileys oficial já aceita um `contextInfo` próprio no conteúdo, então não precisamos de fork.
- **Regra do WhatsApp:** em grupos com mais de 32 membros, só admins podem usar o @todos. Por isso
  `mentionAllMode` escolhe o **nativo** quando o grupo tem até 32 membros ou a conta é admin.
  Nos demais casos usa a **marcação oculta** (ADR-029), que notifica igual, só sem o destaque. Com
  o número de membros desconhecido, usa a oculta (não arrisca). O `sendContext` grava
  `mencoes=todos` ou `mencoes=N`.
- **Posição do marcador:** onde o usuário escreveu "@todos", "@all" ou "@everyone"; se ele não
  escreveu, vai no começo. Só o primeiro é trocado; e-mail e palavras como "@todosjuntos" não
  contam.
- **Marcador confirmado pelo celular:** não se sabe se o celular em português grava "@todos" ou
  "@all". Quando o dono manda um @todos pelo celular num grupo, a mensagem chega a este aparelho
  vinculado. O sistema guarda **só o formato**, nunca o texto: as palavras depois de "@" que não
  são números, e os campos de menção. Isso vai para `mencao-todos.json`, ao lado da pasta da
  sessão, e o envio passa a usar o mesmo marcador. Sem captura, vale o padrão `@all`.

---

## ADR-040 · LGPD: termos com aceite, direitos do titular e prazo de guarda de 6 meses

**Data:** 2026-09-30 · **Status:** aceita · **Autor:** claude · **Branch:** dev

O sistema passa a ser vendido para donos de festa (pessoa física como mantenedora, sem CNPJ). O
nome do produto passa a ser **DocDrop**. O dono pediu adequação à LGPD, com prazo de guarda de 6
meses.

- **Papéis:** o DocDrop é controlador dos dados da conta e operador dos dados das campanhas
  (grupos, mensagens, membros), que são do cliente. Os Termos de Uso trazem a cláusula de
  operador; não há contrato separado.
- **Páginas públicas** `/privacidade` e `/termos` (sem login), com o contato de `CONTACT_EMAIL`
  vindo de `GET /api/legal` (rota pública nova).
- **Aceite:** colunas aditivas `User.termsAcceptedAt` e `User.termsVersion` (migration
  `20260930000000_terms_acceptance`). `/api/auth/me` e o login passam a devolver
  `user.termsPending` (campo novo, aditivo). Enquanto pendente, o painel mostra só a tela de
  aceite; o servidor não bloqueia a API (o registro do aceite é o que importa). Mudou o texto de
  forma relevante: troque `TERMS_VERSION` em `auth.ts` e todos aceitam de novo.
- **Direitos do titular:** `GET /api/account/export` (JSON com conta, acessos, grupos, mídias e
  campanhas; nunca a senha) e `POST /api/account/delete` (exige a senha). A exclusão apaga
  campanhas (cascata: mensagens, horários, envios, leituras), mídias, grupos, recibos pendentes,
  o ritmo do número (se nenhuma outra conta o usou), o usuário (cascata: sessões e registro do
  WhatsApp), faz logout do WhatsApp e remove `users/<id>` da pasta de sessões. Trava número e
  campanhas na mesma ordem do despachante e recusa com envio em andamento. Administrador não se
  exclui (evita ficar sem admin e a ponte da sessão legada); `DELETE /api/admin/users/:id`
  atende pedido recebido por e-mail, só para contas USER.
- **Prazo de guarda** (`purgeExpiredData`, na partida + 2 min e a cada 6 h): apaga de vez as
  campanhas excluídas (a exclusão continua lógica na hora, e vira física em até 6 h), as
  COMPLETED/CANCELLED sem mudança há 180 dias, mídias fora de qualquer campanha há mais de 1 dia
  e grupos inativos há 180 dias sem campanha nem envio. Cada campanha sai numa transação com
  `lockCampaign`, conferindo de novo o estado e sem PENDING/PROCESSING.
- **Cookies:** só o de sessão, essencial; sem banner.
- **Documentos internos:** `docs/lgpd/registro-operacoes.md` e `docs/lgpd/plano-incidentes.md`.

---

## ADR-041 · Proteção do número: silêncio, limite diário, intervalo por grupo e pausa automática

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev

O maior risco do negócio é o WhatsApp restringir o número de um cliente. O dono aprovou, além
do intervalo mínimo entre envios (ADR-006/035), regras por conta com padrões seguros. Variações de
texto e intervalo aleatório (T-133/T-134) ficaram para depois, a pedido do dono.

- **Regras** (`SendingPolicy`, uma linha por conta; sem linha valem `DEFAULT_RULES`; null desliga):
  janela de silêncio **22:00 às 08:00** (horário de São Paulo, pode virar a meia-noite), **150
  envios por dia por número** (10 a 1000), **2 h entre envios ao mesmo grupo** (30 min a 24 h) e
  **pausa automática** ligada. Editadas na tela WhatsApp (`GET/PUT /api/sending-policy`).
- **Onde valem:** em `claimDelivery`, depois do intervalo do número e sob o mesmo lock do número,
  só para envio real (`paceKey` não nulo). Barrado não falha nem muda nada no banco: o envio
  continua PENDING e sai quando a regra libera. Não mexe em `nextAvailableAt` da campanha (a conta
  de pausar/retomar, `resumeAt`, continua a mesma).
- **Limite diário** conta cada envio do número no dia (`attemptedAt` desde 00:00 de São Paulo, de
  todas as campanhas do número): tentativa que falhou também conta, porque pode ter saído.
  Índice novo `Delivery(attemptedAt)`.
- **Intervalo por grupo** conta do último envio que saiu (`SENT`) para o mesmo `groupId`, de
  qualquer campanha da conta. Como a fila é em ordem, a cabeça segurada segura a campanha; as
  outras campanhas do número seguem.
- **Custo:** `claimDelivery` avisa o motivo por um callback opcional (`onBlocked`); o despachante
  guarda "segurado até" em memória (no máximo 5 min) e não repete a transação a cada varredura.
  Salvar as regras solta tudo na hora (`releaseRuleHolds`).
- **Previsão:** `forecastQueue` recebe as regras, o uso do dia e o último envio por grupo e aplica
  a mesma `ruleBlock`. Envio segurado por regra mostra o motivo ("Horário de silêncio · sai amanhã
  às 08:00") e nunca aparece como "Atrasado".
- **Pausa automática** (`safety.ts`): desconexão 403, erro de limite do WhatsApp (429 /
  rate-overlimit) no envio, ou **3 recusas do servidor em 1 hora** (conferido a cada minuto, só as
  recusas depois da última pausa). Pausa todas as campanhas reais ativas da conta, grava
  `WhatsAppSession.safetyPausedAt/safetyReason` e o aviso aparece no Início e na tela WhatsApp
  (`status.safety`) até "Entendi" (`POST /api/whatsapp/safety/dismiss`). Retomar é manual.
- **Testes:** no banco de teste descartável os padrões ficam desligados (como o piso de
  intervalo): os testes de fila rodam a qualquer hora. As regras são testadas com linha explícita.

---

## ADR-042 · Intervalo entre envios sorteado (1:45 a 3:00), sem escolha do cliente

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev
**Substitui:** o piso fixo de 2 min da ADR-035 (e a escolha do intervalo por campanha da ADR-028), por decisão explícita do dono.

Um ritmo sempre igual é o padrão mais fácil de o WhatsApp reconhecer como robô. O dono pediu um
intervalo aleatório entre **1 min 45 s e 3 min**, decidido pelo sistema, e que a tela diga
"mais ou menos" quando sai o próximo envio.

- **Sorteio a cada envio** (`drawInterval`, queue.ts): `finishDelivery` sorteia um inteiro entre
  105 e 180 s e grava `nextAvailableAt` do número e da campanha (e `lastIntervalSeconds`).
  `claimDelivery` reserva o número pelo máximo (180 s) enquanto o envio está em andamento, e
  `accountAllows` exige ao menos o mínimo (105 s) desde `lastSendEndedAt`. Depois de uma queda,
  `holdInterruptedAccounts` usa o máximo.
- **Média 143 s** (`TYPICAL_INTERVAL_SECONDS`): a previsão usa o intervalo real já sorteado para o
  próximo envio e a média para os seguintes; a tela mostra "por volta das HH:MM (em N min)".
- **Planejador:** horários planejados espaçados pelo mínimo (105 s). São só o "não antes de";
  espaçar pelo máximo anularia o sorteio.
- **`Campaign.intervalSeconds`** continua na tabela e a API ainda o aceita (120 a 3600, padrão 120),
  só por compatibilidade: a fila de produção o ignora e o formulário não o envia mais (sem
  migration destrutiva). O painel mostra "1 min 45 s a 3 min" e a duração aproximada da rodada.
- **Testes:** no banco de teste com `SEND_INTERVAL_FLOOR_SECONDS` definido, vale o intervalo da
  campanha com esse piso (os testes de ritmo medem em segundos), como antes. O sorteio tem teste
  de unidade e um de integração que remove o piso.

---

## ADR-043 · Aquecimento de número novo, perguntado uma vez por número

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev

Chip novo que já sai mandando muito é o caso de maior risco de banimento (promoters costumam
comprar um chip só para divulgação). O sistema não sabe a idade de um número, então pergunta.

- **Pergunta** "Este número é novo (criado há menos de 1 mês)?" na tela WhatsApp, quando o número
  conectado ainda não tem resposta. **Uma vez por número:** a resposta fica em
  `WhatsAppSession.warmupJid` (o número) e `warmupStartedAt` (início; null = não é novo).
  Reconectar o mesmo número não pergunta; outro número pergunta de novo e não herda o
  aquecimento. Dá para mudar depois (`POST /api/whatsapp/warmup { isNew }`); "sim" de novo não
  reinicia um aquecimento em andamento. Sem resposta, nada muda no ritmo.
- **Limite:** dias 1 a 3: 30 envios/dia; dias 4 a 7: 80; depois o limite diário da conta. Vale o
  menor entre o aquecimento e o limite da conta, e o aquecimento vale mesmo com o limite diário
  desligado. Dias contados no horário de São Paulo (dia 1 = dia em que começou).
- **Onde:** `rulesFor(db, userId, accountJid)` inclui `warmupStartedAt` só se a resposta é deste
  número; `dailyLimitOn(rules, at)` dá o limite do dia e `ruleBlock` o usa (ADR-041). A previsão
  mostra "Aquecendo o número (dia 2 de 7): limite de 30 envios hoje · continua amanhã às 08:00".
- **Status:** `GET /api/whatsapp/status` traz `warmup` quando conectado; `GET /api/sending-policy`
  traz `todayLimit` e `warmup`. Migration aditiva `20261001100000_number_warmup`.

---

## ADR-044 · Envio sem resposta nunca trava a fila

**Data:** 2026-09-30 · **Status:** aceita · **Autor:** claude · **Branch:** dev

Em produção (30/09, ~18:00, depois de uma sequência de deploys), um envio com flyer ficou
"Enviando" por mais de 2 h e 40 envios esperaram atrás dele. Causa: o `sock.sendMessage` do
Baileys sobe a mídia **sem limite de tempo** se não receber `mediaUploadTimeoutMs` (o padrão é
nenhum); um upload pendurado (típico logo após reconectar) nunca volta, e a faixa do número fica
ocupada para sempre.

- **Upload com teto:** `sendMessage(jid, content, { mediaUploadTimeoutMs: 3 min })`.
- **Vigia do envio** (dispatcher): `provider.send` corre contra 5 min (`SEND_TIMEOUT_MS`). Sem
  resposta: FAILED **incerto** (`errorCode = envio:sem-resposta`, sem reenvio automático, ADR-014),
  a conexão é renovada sem logout (`WhatsAppProvider.recycle`, o fluxo de queda reconecta com a
  mesma sessão) e a fila do número segue.
- **Resposta atrasada:** se o envio abandonado ainda responder, `confirmLateSend` transforma o
  FAILED com esse código em SENT com o id da mensagem (recibos passam a casar).
- **Faxina** (a cada minuto): PROCESSING com `attemptedAt` há mais de 7 min que não está saindo
  neste processo vira o mesmo FAILED incerto (`releaseStuckSends`). Pega qualquer caso que
  escape do vigia. A partida continua marcando todo PROCESSING como incerto.

---

## ADR-045 · Relatório da campanha, resumo por dia e canal de sugestões e críticas

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev

Pedidos do dono para vender o sistema: mostrar o resultado de uma campanha a quem não tem login,
ver os números de um dia passado e ter um lugar para os usuários sugerirem e reclamarem (ele quer
lançar uma atualização por semana, guiada por esse retorno).

- **Relatório** (`report.ts`): `GET /api/campaigns/:id/report` (dono) devolve só NÚMEROS: totais
  (envios, entregues, falhas, fila, visualizações, alcance), por grupo e por dia. A página
  `/campanhas/:id/relatorio` fica fora da moldura do painel e imprime inteira (`@media print` em
  styles.css): "Imprimir ou salvar em PDF" usa a impressão do navegador, sem biblioteca de PDF.
- **Link público:** coluna aditiva `Campaign.reportToken` (único, 32 caracteres aleatórios).
  `POST/DELETE /api/campaigns/:id/report/share` cria e desativa; `GET /api/public/report/:token` é
  a única rota pública nova (entra em `PUBLIC_API` pelo padrão da rota casada). O link nunca
  expõe texto de mensagem, mídia, telefone, id interno nem o dono; código errado, link desativado
  e campanha excluída respondem o mesmo 404. O token fica em texto no banco (o dono precisa
  copiá-lo de novo) e dá acesso só a contagens, revogável.
- **Resumo do dia:** `GET /api/dashboard/day?date=AAAA-MM-DD` (só da conta, até 180 dias atrás, no
  fuso de São Paulo): totais, envios por hora e por campanha. No Início, cada barra do gráfico é
  um botão que abre esse resumo.
- **Sugestões e críticas:** tabela nova `Feedback` (tipo, mensagem, situação, resposta), apagada em
  cascata com a conta e incluída na exportação da LGPD. `POST/GET /api/feedback` (só os próprios,
  5 por hora por conta); `GET/PATCH /api/admin/feedback` (administrador lê tudo, muda a situação
  e responde). Tela `/sugestoes` no menu da conta e bloco na Administração.
- Migration aditiva `20261001200000_feedback_and_report`.

---

## ADR-046 · Sessão do WhatsApp cifrada em repouso, opcional por SESSION_KEY

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev · **Fecha:** T-024

A credencial e as chaves de cada número ficavam em JSON legível na pasta de sessões: quem copiasse
a pasta ou um backup usava o WhatsApp do cliente.

- **Opcional:** só com `SESSION_KEY` (32+ caracteres; a chave AES-256 sai dela por scrypt). Sem a
  variável, nada muda: mesmos arquivos, mesmo formato do Baileys.
- **Formato:** `enc:v1:` + base64(iv 12 | tag 16 | dados), AES-256-GCM, IV novo a cada gravação.
  Vale para `creds.json`, `creds.json.bak` e todos os arquivos de chave; a gravação continua
  atômica (ADR-036).
- **Leitura dos dois formatos:** texto puro continua sendo lido com a chave ligada, e na primeira
  abertura os arquivos antigos são regravados cifrados, um por vez. Não há passo manual.
- **Chave errada ou ausente é ERRO, não "ilegível"** (`SessionKeyError`): `useDurableAuthState` para
  antes de tocar em qualquer arquivo. Sem isso, o caminho de "credencial ilegível" da ADR-036
  guardaria a sessão boa de lado e pediria QR. A conexão fica em erro com a mensagem (sem tentar
  de novo), e `hasPairedSession` continua respondendo que há sessão.
- **Limite:** protege cópia da pasta e backups. Não protege contra quem lê as variáveis de
  ambiente do processo. Perder ou trocar a chave obriga a ler o QR de novo.

---

## ADR-047 · Modelos de campanha, listas de grupos e "esqueci minha senha"

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev · **Fecha:** T-145, T-146, T-147

Pedidos do dono: não remontar toda semana a mesma campanha, não marcar os mesmos grupos um a um,
e o cliente conseguir voltar a entrar sem o administrador inventar uma senha para ele.

- **Modelo = campanha marcada.** Coluna aditiva `Campaign.isTemplate`. Um modelo é uma campanha em
  RASCUNHO que nunca é enviada: reaproveita texto, mídia, grupos, horários, formulário e o
  "duplicar" que já existiam, em vez de uma segunda tabela com as mesmas colunas. Consequência:
  **toda consulta que lista ou conta campanhas para o usuário filtra `isTemplate: false`** (lista
  de campanhas, contagens do admin). A fila não precisa: modelo não tem entregas e a rota de status
  recusa ativá-lo.
  - `GET /api/templates` lista os modelos (no máximo `MAX_TEMPLATES` = 50 por conta).
  - `POST /api/campaigns/:id/duplicate` aceita `asTemplate`: de campanha para modelo ("Salvar como
    modelo") e de modelo para campanha ("Usar": cria um rascunho com as datas de hoje). O campo
    `isTemplate` aparece em `GET /api/campaigns/:id`.
  - Editar um modelo (`PATCH /api/campaigns/:id`) dispensa as regras de data: período no passado e
    horário já vencido não fazem sentido para algo que não é enviado.
- **Listas de grupos.** Tabelas novas `GroupList` e `GroupListItem`, com chave estrangeira composta
  por `userId` (uma lista só aponta para grupos da mesma conta) e apagadas em cascata com a conta e
  com o grupo. `GET/POST /api/group-lists`, `PATCH/DELETE /api/group-lists/:id`; nome único por
  conta (409), até 50 listas de 500 grupos. A lista só ajuda a MARCAR grupos no formulário: a
  campanha continua guardando os próprios grupos, então mudar ou apagar a lista não mexe em
  campanha nenhuma. Entram na exportação da LGPD.
- **Esqueci minha senha por link de uso único.** Tabela nova `PasswordReset` (guarda só o sha256
  do código; `tokenHash` nulo = pedido esperando o administrador). Rotas públicas novas em
  `PUBLIC_API`: `POST /api/auth/forgot`, `GET` e `POST /api/auth/reset/:token`.
  - O pedido responde igual exista a conta ou não, e tem limite de 5 por 15 min por IP e por e-mail.
  - **Entrega:** sem e-mail configurado, o pedido aparece na Administração e o administrador gera o
    link (`POST /api/admin/users/:id/reset-link`, vale 24 h) e manda pelo canal que já usa com o
    cliente. Com `RESEND_API_KEY` + `MAIL_FROM`, o link vai por e-mail (vale 1 h). Escolhido assim
    porque hoje não há domínio nem serviço de e-mail; o fluxo do administrador funciona desde já e
    o e-mail liga sem mudar código.
  - Trocar a senha pelo link apaga o link, derruba todas as sessões da conta e usa a mesma trava
    `FOR UPDATE` do login. Ninguém, nem o administrador, fica sabendo a senha.
  - O endereço do link sai de `PUBLIC_URL`, nunca do cabeçalho `Host` do pedido.
- Migration aditiva `20261002000000_templates_lists_reset`.
- **Fora desta decisão:** login com Google ou Apple. Só levantamento, entregue ao dono; depende de
  domínio próprio com HTTPS.

---

## ADR-048 · Avisos no WhatsApp do dono

**Data:** 2026-10-01 · **Status:** aceita, falta validar num número real (T-149) · **Autor:** claude · **Branch:** dev · **Fecha:** T-148

Pedido do dono: saber, sem abrir o painel, quando uma campanha terminou ou foi pausada. E-mail
depende de domínio; o WhatsApp do próprio cliente já está conectado.

- **O que avisa:** (1) campanha real (`baileys`) concluída, com envios feitos e falhas; (2) pausa
  automática por sinal de restrição (ADR-041). Falha isolada não avisa (entra no resumo do fim).
  Queda da conexão não avisa: sem conexão não há por onde mandar.
- **Para onde:** o próprio número conectado (conversa "Você"; por ser mensagem do próprio número,
  o celular não notifica) ou outro número escolhido pelo dono, resolvido a cada aviso por
  `onWhatsApp` (cobre o nono dígito). Opcional e desligado por padrão.
- **Fora da fila de envio.** `queue.ts` e `schedule.ts` não mudam. `owner-alerts.ts` roda a cada
  30 s no processo do servidor:
  - `collectAlerts` grava um `OwnerAlert` por FATO, com chave única (`fim:<campanha>:<último envio>`,
    `pausa:<conta>:<quando>`): o mesmo fato nunca avisa duas vezes; "tentar de novo" tem outro
    último envio e avisa de novo. Só fatos de depois de `AlertSettings.enabledAt` e das últimas 6 h.
    O "quando" da campanha é o último `attemptedAt`, não `updatedAt` (que muda por outros motivos).
    Espera 2 min depois do último envio: uma recusa atrasada do servidor reabre a campanha.
  - `deliverAlerts` manda pela conexão DO DONO (mesmo roteador da fila), um por conta a cada
    rodada, nunca enquanto um envio da conta está em andamento. O aviso é reservado antes de sair:
    se o envio falhar, fica o motivo e não é repetido (no máximo uma vez, nunca duplicado). Sem
    conexão, espera; passadas 6 h, é abandonado.
- **Não é envio de campanha:** não conta no limite do dia, não mexe no relógio do número, não
  respeita o horário de silêncio (é uma mensagem para o próprio dono) e nunca vai para grupo
  (`notify` recusa `@g.us`).
- **Contrato novo:** `GET/PUT /api/alerts` (`{ enabled, phone }`; o telefone é guardado em dígitos
  com DDI, e DDD + número ganha o 55) e `POST /api/alerts/test` (3 a cada 10 min por conta).
  `WhatsAppProvider.notify(text, phone?)`.
- **Dados:** tabelas novas `AlertSettings` e `OwnerAlert`, apagadas em cascata com a conta; avisos
  com mais de 30 dias são apagados. A preferência entra na exportação da LGPD e a Política de
  Privacidade ganhou a linha "Avisos" (sem mudar a versão dos termos: é dado opcional).
- Migration aditiva `20261002100000_owner_alerts`.
- **Limite conhecido:** `notify` foi testado com conector falso. Mandar para o próprio número e
  resolver outro número pelo Baileys precisa de um teste num WhatsApp de verdade (botão "Enviar
  aviso de teste" na tela WhatsApp).

---

## ADR-049 · Intervalo de 1:30 a 3:00 sem faixa na tela; regras de envio só para o administrador

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev · **Ajusta:** ADR-041, ADR-042

Pedido do dono: a faixa do intervalo não deve ficar aparente para o cliente, o mínimo cai de 1:45
para 1:30, e o cliente não vê nem muda as regras de proteção do número.

- **Mudança de contrato:** `GET` e `PUT /api/sending-policy` passam a exigir `SUPER_ADMIN` (403 para
  os demais). O cartão "Proteção do número" só aparece para o administrador. As regras continuam
  valendo para TODAS as contas: sem linha em `SendingPolicy`, os padrões (22h–8h, 150 por dia, 2 h
  por grupo, pausa automática); com linha, o que estava salvo. Nenhum dado foi alterado.
  - Continuam do cliente: a pergunta "este número é novo?" (`POST /api/whatsapp/warmup`), o aviso
    de pausa automática e o "Entendi" dele, e os avisos no WhatsApp (ADR-048).
  - **Limite conhecido:** o administrador só ajusta as regras da PRÓPRIA conta. Ajustar as de um
    cliente pela Administração fica para a tarefa de planos por cliente.

- `SEND_INTERVAL` passa de 105–180 s para **90–180 s**; a média das previsões
  (`TYPICAL_INTERVAL_SECONDS`, e a cópia dela em `apps/web/src/design/format.ts`) passa de 143 para
  **135 s**. Quem sorteia e quem confere continuam sendo `queue.ts` e `claimDelivery`; o piso de
  teste e o resto da fila não mudam.
- A interface deixa de mostrar a faixa: saiu o bloco "Intervalo entre grupos" do formulário e o
  "um a cada…" da confirmação de iniciar. Ficam só as durações aproximadas ("~24 min por rodada"),
  que já existiam no formulário e no resumo da campanha.

---

## ADR-050 · Plano por conta (vencimento, pausa, grupos por campanha) e regras de envio na Administração

**Data:** 2026-10-01 · **Status:** aceita · **Autor:** claude · **Branch:** dev · **Fecha:** T-151 · **Ajusta:** ADR-049

Pedido do dono: vender com mensalidade e "pausa" nos meses sem festa, cobrando por fora (Pix ou
link do Mercado Pago), e ajustar as regras de cada cliente pela Administração.

- **Tabela nova `Subscription`** (uma linha por conta, apagada em cascata): `plan` (nome livre),
  `priceCents` (valor combinado, só o administrador vê), `dueDate` (último dia pago, data do
  calendário de São Paulo), `pausedAt` (conta pausada) e `maxGroups` (grupos por campanha).
  Sem linha = sem plano: nada vence e nada limita. **Administrador não tem plano** e nunca é
  bloqueado.
- **Vencida ou pausada = não envia, mas continua entrando.** Nada é apagado nem escondido.
  - `PATCH /api/campaigns/:id/status` recusa iniciar ou retomar (pausar e encerrar continuam
    valendo); `retry` e `retry-failed` recusam, porque reabrem a campanha.
  - As campanhas ATIVAS da conta são pausadas do mesmo jeito do botão Pausar (`lockCampaign`,
    `LOCKING_TRANSACTION`): na hora em que o administrador salva o plano e por uma conferência a
    cada minuto (`startPlanSweep` em main.ts), que é o que faz o vencimento valer na virada do
    dia. **`queue.ts` e `schedule.ts` não mudam**: a fila só vê campanhas pausadas.
  - Vence DEPOIS do dia de `dueDate` (a conta envia até o fim daquele dia). Pausa ganha de
    vencimento na situação mostrada.
- **Grupos por campanha:** conferido ao criar e editar (mensagem na hora) e de novo ao iniciar ou
  retomar (vale mesmo se o plano mudou depois ou a campanha veio de uma cópia).
- **Contrato novo:** `GET /api/plan` (a própria conta, sem o valor); `GET/PUT
  /api/admin/users/:id/plan`; `GET /api/admin/users` ganha `plan` em cada conta.
- **Mudança de contrato (regras de envio):** `GET/PUT /api/sending-policy` saíram. No lugar,
  `GET/PUT /api/admin/users/:id/sending-policy` (SUPER_ADMIN), para qualquer conta, inclusive a do
  próprio administrador. O cartão saiu da tela WhatsApp; as regras ficam na janela "Plano e
  regras" de cada conta, na Administração.
- **Para o cliente:** cartão "Seu plano" em Minha conta e uma faixa no topo do painel quando
  faltam 5 dias ou menos, quando venceu ou quando a conta está pausada.
- **Fora desta decisão:** cobrança automática (Mercado Pago avisando o sistema para renovar a
  data), que depende de domínio com HTTPS; limite de números por conta (hoje é sempre um).
- Migration aditiva `20261002200000_subscription`.

---

## ADR-051 · Início com a previsão real do próximo envio; index.html com o endereço público

**Data:** 2026-10-02 · **Status:** aceita · **Autor:** claude · **Branch:** dev · **Fecha:** T-152

Pedido do dono: o bloco "Em andamento" dizia "enviando" em pleno horário de silêncio, e o site
precisava de ícone e de metadados para busca e compartilhamento.

- **Previsão real no Início.** `GET /api/dashboard` passa a calcular, para cada campanha em
  andamento, o próximo envio com a MESMA previsão do detalhe (`forecastQueue`): silêncio, limite
  do dia, intervalo do grupo, relógio do número e conexão do dono. Mudança ADITIVA na resposta:
  cada item de `runningCampaigns` ganha `failed`, `pending`, `delivered` e
  `next: { group, expectedAt, reason, kind } | null`. `nextDelivery` continua igual.
  - `kind` (`waitKind` em queue-forecast.ts) é o tipo da espera para a tela escolher o selo sem
    interpretar texto: sending, now, quiet, daily, group, retry, offline, paused, pace, scheduled.
    Ele sai dos prefixos dos motivos montados no mesmo arquivo: mudou o texto lá, mude a tabela.
  - A previsão roda FORA da transação de leitura do painel (`running-forecast.ts`) e olha só os
    5 primeiros envios da fila de cada campanha. `queue.ts` e `schedule.ts` não mudam.
  - `registerCampaignRoutes(app, connectedOf)` recebe quem sabe se a conexão da conta está de pé.
- **index.html pelo servidor.** O `onRequest` de `registerWeb` e o fallback do painel devolvem o
  index.html com `__PUBLIC_URL__` trocado por `PUBLIC_URL` (og:image, og:url e dados
  estruturados precisam de endereço completo). O arquivo é relido quando muda; os demais arquivos
  continuam pelo `@fastify/static`. Consequência: o index.html não usa mais a versão
  pré-comprimida (é pequeno).
- **Arquivos públicos novos** em `apps/web/public`: favicon.svg, PNGs gerados por
  `scripts/make-icons.cjs`, site.webmanifest, robots.txt (libera só /login, /notas, /privacidade
  e /termos) e og.png.
- **Adendo (T-155, 2026-10-02):** a resposta do painel ganha, de forma aditiva, `usage` (envios do
  número hoje, limite que vale hoje, aquecimento e janela de silêncio, só leitura) e `media` em
  cada item de `runningCampaigns`. A tela deixou de usar `recentActivity`, que continua na resposta.
  O cliente passa a VER o limite do dia e o horário de silêncio da própria conta (pedido do dono),
  mas continua sem poder mudá-los (ADR-049/050).
- **Limite:** o painel fica atrás de login. Estas tags deixam o link correto ao ser compartilhado
  e legível para buscadores, mas posição no Google depende de página pública com conteúdo
  (uma página de apresentação), que não existe.

---

## ADR-052 · Serializar comandos de conta e preservar a revisão sem alterar a fila

**Data:** 2026-10-02 · **Status:** aceita · **Autor:** codex · **Branch:** dev · **Fecha:** T-153

Revisão solicitada pelo dono, incremental, sem stack nova, schema novo ou contrato HTTP novo.

- Comandos que dependem do plano ou de uma cota por conta travam `User` ANTES de `Campaign`,
  e revalidam dentro de `LOCKING_TRANSACTION` (READ COMMITTED). Atualizar plano e pausar suas
  campanhas é uma transação; a varredura revalida o candidato após a trava. A fila continua
  travando número → campanha e não passa a consultar o plano a cada envio. A tolerância de
  até um minuto no vencimento da ADR-050 permanece; `queue.ts` e `schedule.ts` não mudaram.
- Links de senha: emissão/consumo serializados por usuário, nova checagem de vencimento ao
  consumir, revogação na troca própria/administrativa e conta ativa revalidada ao emitir.
- Link público de relatório: criação e revogação serializadas por campanha; pedidos
  simultâneos recebem o mesmo código. Mesmos campos e mesmas permissões anteriores.
- Avisos: uma rodada pega no máximo um pendente por dono (até 50 donos), com ordem estável.
  Expirados são descartados antes. A reserva continua impedindo reenvio incerto. Não se
  acrescentou reconexão, retentativa automática nem alteração em `OwnerAlert.sentAt`.
- Parada: despachante e tarefas periódicas começam a encerrar juntos, antes das conexões
  e do banco. O teste de partida usa porta/pasta de sessões temporárias, sem WhatsApp real.
- Sessão no painel: revisão de autorização ignora 401 de pedidos anteriores a uma troca
  de sessão. Consulta da sessão e página de redefinir senha ignoram respostas obsoletas.
- Sessão em disco: `writeAtomic` serializa chamadas pelo caminho numa fila separada das
  travas de credencial/leitura, para não esperar pela própria trava. Resolve EPERM observado
  em substituições simultâneas no Windows e preserva formato, fsync, rename e limpeza;
  a última chamada vence. Regressão existente reforçada e repetida dez vezes no Windows.
- Sem migration, dependência nova ou alteração da LGPD. Limitações que exigem decisão
  (eventos precoces T-126, reserva dos avisos, resumo diário de campanhas excluídas), auditoria
  de dependências T-049 e validações reais estão em `docs/review-2026-10-02.md`.
