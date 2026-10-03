# STATE — onde o projeto está agora

> Atualize este arquivo sempre que a arquitetura, a fase ou o conjunto de serviços mudar.
> Ele responde a uma pergunta: *se eu chegasse agora, o que eu precisaria saber?*

**Última atualização:** 2026-10-03 · por `codex`

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
| 5u | Proteção ignora recusas com confirmação de entrega/leitura; falso alarme comprovado retoma somente pendentes, sem desfazer restrições reais (ADR-053) | ✅ concluída (T-157) |
| 0 | Protótipo local funcional | ✅ concluída |
| 1 | Protocolo multi-agente, limpeza, auditoria de segurança | ✅ concluída (ADR-023) |
| 2 | Autenticação + papéis + isolamento por dono | ✅ concluída (ADR-016/017/018) |
| 3 | Uma sessão de WhatsApp por usuário | ✅ concluída (ADR-019/020/021/022/024) |
| 4 | Envios em paralelo entre números, design system, painel do admin | ✅ concluída (ADR-025/026) |
| 5 | Piso de intervalo no banco, @todos, tentar de novo, métricas do admin | ✅ concluída (ADR-028/029/030/031) |
| 5b | Conversão de vídeo, estado do WhatsApp gravado, painel sem tela branca, rolagem | ✅ concluída (ADR-032/033) |
| 5c | Troca de tela instantânea, limites contra abuso, VPS pequena, ffmpeg seguro | ✅ concluída (ADR-034) |
| 5d | Sync automático de grupos, piso de 2 min, "Atrasado" preciso, UI enxuta | ✅ concluída (ADR-035) |
| 5e | Sessão do WhatsApp à prova de queda e de deploy | ✅ concluída (ADR-036) |
| 5f | Painel 100% responsivo (320–1440 px) e sem trava de rolagem no Android | ✅ concluída (T-123) |
| 5t | Revisão de recuperação de senha, planos/limites simultâneos, links de relatório, avisos e respostas atrasadas de sessão (ADR-052) | ✅ promovida para main com autorização (T-153/T-154) · ver docs/review-2026-10-02.md |
| 5t | Campanhas: arquivar, filtro por situação, limite por conta (padrão 8) e fim do "rascunho" na tela; parâmetros da conta em janela com seções (ADR-054) | ✅ concluída (T-159) |
| 5s | Ícone e metadados do site; mensagem da campanha com imagem ampliável; "Em andamento" com a previsão real; notas de atualização mais limpas (ADR-051) | ✅ concluída (T-152) |
| 5r | Plano por conta: vencimento, pausa e grupos por campanha; regras de envio de cada conta na Administração (ADR-050) | ✅ concluída (T-151) |
| 5q | Regras de proteção do número visíveis e editáveis só pelo administrador; intervalo 1:30 a 3:00 sem faixa na tela (ADR-049) | ✅ concluída (T-150) |
| 5p | Avisos no WhatsApp do dono: campanha concluída e pausa automática (ADR-048) | ✅ na dev (T-148) · falta validar num número real (T-149) |
| 5o | Modelos de campanha, listas de grupos e "esqueci minha senha" por link de uso único (ADR-047) | ✅ na dev (T-145, T-146, T-147) |
| 5n | Relatório da campanha com link público, resumo por dia, sugestões e críticas (ADR-045); sessão cifrada opcional (ADR-046) | ✅ na dev (T-142, T-143, T-144, T-024) |
| 5m | Notas de atualização para o cliente em /notas, com ícone no menu | ✅ na dev (T-139) |
| 5l | Envio sem resposta nunca trava a fila: teto de upload, vigia, faxina (ADR-044) | ✅ na dev (T-138) · o dono leva para a main |
| 5k | Aquecimento de número novo, perguntado uma vez por número (ADR-043) | ✅ concluída (T-134) |
| 5j | Intervalo entre envios sorteado de 1:30 a 3:00 (era 1:45, ADR-049), sem escolha nem faixa na tela (ADR-042) | ✅ concluída (T-137) |
| 5i | Proteção do número: silêncio, limite diário, intervalo por grupo, pausa automática (ADR-041) | ✅ concluída (T-131, T-132, T-135, T-136) · T-133/T-134 aguardam o dono |
| 5h | Nome DocDrop e LGPD: termos, aceite, baixar/excluir dados, 6 meses (ADR-040) | ✅ concluída (T-129, T-130) |
| 5g | Revisão do codex (ADR-037), animações (ADR-038), @todos nativo (ADR-039) | ✅ código pronto · @todos validado pelo dono num grupo real em 2026-10-01 (T-127) |
| 6 | CI com lint, build, testes e MySQL descartável (T-006); observabilidade externa | ✅ CI · observabilidade externa não implementada |

---

## Arquitetura vigente

```
server.js     entrada: aplica migrations e sobe apps/server   → porta 3000 (painel + /api)
apps/web      Vite + React 19 + React Router + Tailwind       → compilado em apps/web/dist
apps/server   Fastify 5: login, segurança, painel, fila, WhatsAppManager (Baileys por usuário)
packages/database  Prisma 6 + MySQL 8 (nativo no Windows, banco `campanhas`)
infra         nenhuma. Sem Docker, sem Redis. Ver ADR-008 e ADR-010.
```

Um único processo Node. Toda rota `/api` exige sessão (negar por padrão), conferida no
`onRequest`, antes de ler o corpo. Alvos de deploy: VPS própria (`docs/deploy-vps.md`, pensada
para 1 vCPU e 1 GB) e **Railway** (`docs/deploy-railway.md`, `railway.json`); a Hostinger
(`docs/deploy-hostinger.md`) foi o deploy anterior. Limites em memória (ADR-034): API por IP,
verificações de senha, uploads simultâneos.

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

1. Usuário cria campanha (`DRAFT`) escolhendo grupos, mensagens, modo e, opcionalmente,
   "marcar todos os membros" (ADR-029). Intervalo de produção é sorteado por envio
   (90–180 s, ADR-042/049), não escolhido pelo cliente; `intervalSeconds` continua por compatibilidade.
2. Ao ativar, `apps/server/src/schedule.ts::planDeliveries` materializa **todas** as
   entregas no MySQL com `sequence` fixa. Isso só acontece na primeira ativação.
3. O despachante interno de `apps/server` varre o MySQL a cada 5 s, por **faixa** (uma por
   número de WhatsApp — ADR-025): pega o primeiro pendente de cada campanha na faixa livre.
4. `claimDelivery` reserva PENDING→PROCESSING sob lock (número, depois campanha —
   `LOCKING_TRANSACTION`, READ COMMITTED, ADR-010).
5. Envio pela conexão do DONO da campanha (baileys) ou simulador. `finishDelivery` grava
   SENT/FAILED e empurra `nextAvailableAt` pelo intervalo sorteado para o número.
   `effectiveInterval` é a média usada nas previsões, não o sorteio do envio (ADR-042/049).

### Invariantes que NÃO podem ser quebradas

- Uma entrega reservada **nunca** é repetida automaticamente além do limite
  (`MAX_SEND_ATTEMPTS = 3`, só para falha "certa" — ADR-014). "Tentar de novo" manual existe
  (ADR-030), mas nunca acontece sozinho além desse limite.
- Falha de resultado **incerto** (pode ter chegado) nunca é reenviada sem confirmação explícita
  do usuário — risco de duplicar mensagem (`isUncertainFailure`, `send-context.ts`).
- Só o primeiro pendente (`sequence` mínima) de uma campanha pode ser reservado.
- O intervalo é contado a partir do **fim** da tentativa anterior: 90–180 s em produção.
  `MIN_INTERVAL_SECONDS = 120` é compatibilidade da API; piso reduzido só vale no banco
  descartável de testes (ADR-042/049, `packages/database/src/queue.ts`).
- `Delivery` tem `@@unique([campaignId, sequence])` e `@@unique([campaignId, groupId, scheduledAt])`.
- Um envio nunca sai pela conexão de um usuário que não é o dono da campanha (ADR-022).

---

## Trabalho recente (branch dev, 2026-09-24)

- **ADR-052 / T-153:** revisão integrada até `fafff92`, sem migration nem contrato novo.
  Operações de conta travam usuário antes de campanha; links antigos de senha são revogados;
  avisos pendentes não bloqueiam contas diferentes; respostas antigas não encerram um login novo.
  Relatório e pendências: `docs/review-2026-10-02.md`. Nenhum envio real ou reinício da produção.
- **ADR-028:** piso entre grupos (3 minutos; 2 minutos desde a ADR-035) garantido no banco (não só na API) — protege
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
- T-123: responsivo conferido em 320/360/768/1440 px. `ScrollArea` só rola sozinha no desktop
  (no Android a página não voltava para cima) e as grades têm `grid-cols-1`. Os botões do
  WhatsApp ficam numa linha no celular.
- T-124 (ADR-036): sessão do WhatsApp gravada de forma atômica, com cópia de segurança da
  credencial (`auth-state.ts`). Reconexão sem desistir (no máximo 1 tentativa por minuto). Só o
  401 apaga a sessão. Sem QR em reconexão automática. Encerramento limpo ao fechar a janela.
  No Railway, usa o Volume sozinho.
- T-122 (ADR-035): grupos sincronizados sozinhos ao conectar (botão com espera de 30 s), piso de
  2 minutos, "Atrasado" só quando o próximo envio já podia ter saído e não saiu, o 1º envio sai
  na hora ao iniciar (o despachante é acordado), simulação fora da tela, "Modelo da mensagem"
  recolhível no detalhe, menu no nome do usuário, excluir só na lista.
- Desempenho e segurança (T-121, ADR-034): telas pré-carregadas e com cache (troca de tela de
  1 a 90 ms), painel pré-comprimido (376 KB para 108 KB), login antes de ler o corpo, limites
  por IP/senha/upload, ffmpeg só com o contêiner detectado (fecha a leitura de arquivos do
  servidor por playlist disfarçada), cache de participantes no Baileys, botão "Alterar senha"
  visível em cada conta na Administração.
- Administração (T-120): seções separadas (Visão geral, Envios em 7 dias + erros, Saúde do
  sistema, Contas); "Nova conta" dentro do bloco Contas; ações de cada conta num menu "⋯"
  (`Menu`), filtros em `Segmented`. Só interface: nenhuma rota ou contrato mudou.

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
| 2 | Validação declarativa (Zod) | T-004 descartada: validação manual consolidada e testada, sem dependência nova. |
| 3 | Logs estruturados, métricas externas, tracing | O painel de admin cobre métricas operacionais básicas; não há exportação para uma ferramenta externa (T-005). |
| 5 | Mídia como `Bytes` no MySQL, sem cota (órfãs saem em 1 dia desde a ADR-040) | Cresce sem limite (T-030/T-052). |

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
