# STATE — onde o projeto está agora

> Atualize este arquivo sempre que a arquitetura, a fase ou o conjunto de serviços mudar.
> Ele responde a uma pergunta: *se eu chegasse agora, o que eu precisaria saber?*

**Última atualização:** 2026-09-24 · por `claude`

---

## Fase atual

**Multiusuário completo, em produção.** O sistema tem login obrigatório, papéis
(`SUPER_ADMIN`/`USER`), dados isolados por dono e **cada usuário conecta o próprio número de
WhatsApp** — não existe mais "um único número" nem sessão compartilhada (a sessão legada de
antes do multiusuário só sobrevive via ponte/migração automática, ADR-021/024, até o dono dela
reconectar pela própria conta).

Fases planejadas (histórico; a numeração é anterior ao multiusuário e não reflete mais o
trabalho atual — ver "Trabalho recente" abaixo para o que já saiu):

| Fase | Objetivo | Status |
|---|---|---|
| 0 | Protótipo local funcional | ✅ concluída |
| 1 | Protocolo multi-agente, limpeza, auditoria de segurança | ✅ concluída (ADR-023) |
| 2 | Autenticação + papéis + isolamento por dono | ✅ concluída (ADR-016/017/018) |
| 3 | Uma sessão de WhatsApp por usuário | ✅ concluída (ADR-019/020/021/022/024) |
| 4 | Envios em paralelo entre números, design system, painel do admin | ✅ concluída (ADR-025/026) |
| 5 | Piso de intervalo no banco, @todos, tentar de novo, métricas do admin | ✅ concluída (ADR-028/029/030/031) |
| 5b | Conversão de vídeo, estado do WhatsApp gravado, painel sem tela branca, rolagem | ✅ concluída (ADR-032/033) |
| 6 | Observabilidade além do painel de admin (logs estruturados, CI) | ⬜ não iniciada |

---

## Arquitetura vigente

```
server.js     entrada: aplica migrations e sobe apps/server   → porta 3000 (painel + /api)
apps/web      Vite + React 19 + React Router + Tailwind       → compilado em apps/web/dist
apps/server   Fastify 5: login, segurança, painel, fila, WhatsAppManager (Baileys por usuário)
packages/database  Prisma 6 + MySQL 8 (nativo no Windows, banco `campanhas`)
infra         nenhuma. Sem Docker, sem Redis. Ver ADR-008 e ADR-010.
```

Um único processo Node. Toda rota `/api` exige sessão (negar por padrão). Publicado no
**Railway** (`docs/deploy-railway.md`, `railway.json`) — alvo de deploy atual; a Hostinger
(`docs/deploy-hostinger.md`) foi o deploy anterior.

### Ambientes de trabalho (Git)

- **main** (`C:\...\raf-campanhas`): produção, porta 3000, commit e push direto autorizados
  pelo dono (ver `AGENTS.md` Seção 5).
- **dev** (worktree `raf-campanhas-dev`): banco `campanhas_dev`, porta 3001,
  `SESSIONS_DIR` próprio fora do projeto. Todo trabalho de agente entra por aqui primeiro;
  main recebe por merge depois de testado. O banco da dev NÃO tem as contas da produção: rode
  `npm run dev:sincronizar-login` (na pasta da dev) para o dono entrar na dev com o mesmo
  e-mail e senha da produção (copia só o hash; lê a produção, escreve só em banco `*_dev`).
  Depois de recompilar o painel, reinicie o servidor da dev — senão ele fica fora do ar ou em
  branco ("Sem conexão com o servidor" no login).

### Multiusuário: como os dados se separam

- Toda tabela de dado próprio de conta tem `userId` (FK composta em `Campaign`↔`CampaignMedia`
  e nas junções, para impedir referenciar dado de outro dono mesmo por acidente — ADR-017/018).
- `WhatsAppManager` (`Map<userId, provider>`): um `WhatsAppProvider` Baileys por usuário, pasta
  de sessão própria (`SESSIONS_DIR/users/<userId>/whatsapp`).
- `createSendingRouter`: cada envio busca a conexão pelo **dono da campanha**
  (`Delivery → Campaign.userId → provider`), nunca por uma conexão "global" (ADR-022).
- Ponte da sessão legada (`legacySessionOwnerId`/`legacyOwnerCandidate`): enquanto a sessão de
  antes do multiusuário não migrou, ela só atende quem é comprovadamente o dono inequívoco
  (um único `SUPER_ADMIN` ativo). `migrateLegacySession()` roda **sozinha, na partida**, antes
  de qualquer conexão — rename atômico da pasta legada para a do dono; reversível com
  `npm run whatsapp:reverter-migracao`; `WHATSAPP_MIGRATE_LEGACY=0` desliga.

### Fluxo de uma campanha

1. Usuário cria campanha (`DRAFT`) escolhendo grupos, mensagens, intervalo (mínimo 3 min,
   ADR-028), modo e, opcionalmente, "marcar todos os membros" (ADR-029).
2. Ao ativar, `apps/server/src/schedule.ts::planDeliveries` materializa **todas** as
   entregas no MySQL com `sequence` fixa. Isso só acontece na primeira ativação.
3. O despachante interno de `apps/server` varre o MySQL a cada 5 s, por **faixa** (uma por
   número de WhatsApp — ADR-025): pega o primeiro pendente de cada campanha na faixa livre.
4. `claimDelivery` reserva PENDING→PROCESSING sob lock (número, depois campanha —
   `LOCKING_TRANSACTION`, READ COMMITTED, ADR-010).
5. Envio pela conexão do DONO da campanha (baileys) ou simulador. `finishDelivery` grava
   SENT/FAILED e empurra `nextAvailableAt` em `effectiveInterval(intervalSeconds)` — nunca
   abaixo do piso de 180 s, mesmo que o valor gravado seja menor (ADR-028).

### Invariantes que NÃO podem ser quebradas

- Uma entrega reservada **nunca** é repetida automaticamente além do limite
  (`MAX_SEND_ATTEMPTS = 3`, só para falha "certa" — ADR-014). "Tentar de novo" manual existe
  (ADR-030), mas nunca acontece sozinho além desse limite.
- Falha de resultado **incerto** (pode ter chegado) nunca é reenviada sem confirmação explícita
  do usuário — risco de duplicar mensagem (`isUncertainFailure`, `send-context.ts`).
- Só o primeiro pendente (`sequence` mínima) de uma campanha pode ser reservado.
- O intervalo é contado a partir do **fim** da tentativa anterior, nunca abaixo de 180 s
  (`MIN_INTERVAL_SECONDS`, `packages/database/src/queue.ts`).
- `Delivery` tem `@@unique([campaignId, sequence])` e `@@unique([campaignId, groupId, scheduledAt])`.
- Um envio nunca sai pela conexão de um usuário que não é o dono da campanha (ADR-022).

---

## Trabalho recente (branch dev, 2026-09-24)

- **ADR-028:** piso de 3 minutos entre grupos garantido no banco (não só na API) — protege
  campanhas antigas e qualquer escrita direta.
- **ADR-029:** marcar todos os membros do grupo (@todos oculto), por campanha.
- **ADR-030:** tentar de novo um envio com falha — direto se a falha é certa, com confirmação
  se é incerta; em lote por campanha (só as falhas seguras).
- **ADR-031:** painel do administrador com métricas do sistema inteiro
  (`GET /api/admin/overview`), força-logout e desconectar-WhatsApp por conta, separados de
  "desativar"; tela redesenhada com busca e filtro.
- Design system: `Select` e `Checkbox` próprios (sem visual nativo do sistema operacional,
  `docs/design-system.md`), bordas decorativas removidas (faixa/borda colorida do cartão,
  barra do topo do detalhe), logo "CC" removida do topo e do login.

---

## Operação da produção local (importante)

- NUNCA rode `npm run build` nem `npm install` na pasta do main com a produção ligada. Desde a
  ADR-033 o painel não fica mais em branco por isso, mas o servidor em execução continua com o
  código antigo até reiniciar, e o Prisma trava o próprio arquivo (EPERM).
- Atualizar a produção = fechar o sistema (fora de uma rodada de campanha) e abrir de novo: o
  inicializador instala dependências novas (se o package-lock mudou) e recompila (se o código
  mudou) sozinho.

## O que está ausente (não é mais auditoria de segurança — ver ADR-023 para o que já foi corrigido)

| # | Ausente | Observação |
|---|---|---|
| 1 | Login social (Google) | Avaliado a pedido do dono; ver a seção correspondente no handoff mais recente para o resumo de viabilidade. Não implementado. |
| 2 | Validação declarativa (Zod) | Validação manual e espalhada; funciona, mas divergir é fácil (T-004). |
| 3 | Logs estruturados, métricas externas, tracing | O painel de admin cobre métricas operacionais básicas; não há exportação para uma ferramenta externa (T-005). |
| 4 | CI (GitHub Actions) | Nada impede um merge quebrado além da disciplina manual (T-006). |
| 5 | Mídia como `Bytes` no MySQL, sem cota nem exclusão de órfãos | Cresce sem limite (T-030/T-052). |

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
npm run start:local         # sobe o painel e o servidor único (porta 3000)
npm run build:exe -- --desktop   # gera o .exe de duplo clique (pré-voo + build só se mudou)
npm run db:check            # diagnóstico do MySQL local (cria o banco se faltar)
npm test                    # testes sem WhatsApp
npm run test:integration    # banco MySQL descartável
npm run lint                # tsc --noEmit em tudo
npm run ai:brief            # estado + tarefas + handoff + commits recentes (rode primeiro)
npm run ai:check            # confere se o ritual de encerramento foi cumprido
```
