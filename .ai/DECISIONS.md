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
