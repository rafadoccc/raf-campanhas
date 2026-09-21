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
