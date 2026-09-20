# Auditoria de segurança — setembro/2026

Escopo: `apps/api`, `apps/worker`, `packages/database`, `scripts`, configuração e
dependências. Nenhum arquivo foi alterado durante a auditoria.

**Modelo de ameaça.** API em `127.0.0.1:3001`, worker em `127.0.0.1:3002`. Isso impede
acesso direto pela rede, mas **não** impede nenhum processo local, extensão de navegador,
script de `postinstall`, malware ou outro usuário da máquina. Como não existe autenticação
alguma, **acesso ao loopback equivale a controle total do sistema**.

As tarefas correspondentes estão em `.ai/TASKS.md` como T-040 a T-053.

---

## Crítico

### C1 · Envio real no WhatsApp sem autenticação
`apps/api/src/server.ts:133-173`

A rota ativa uma campanha e, com `provider: "baileys"`, dispara mensagens reais para todos
os grupos. A única autorização é `body.consent !== true` (`:152`) — um booleano enviado
pelo próprio cliente.

Exploração: um processo local chama `GET /groups` (que entrega os JIDs reais), cria uma
campanha com mensagem arbitrária e ativa com `{"status":"ACTIVE","provider":"baileys","consent":true}`.
Resultado: spam ou phishing enviado em nome do titular, com risco de banimento da conta.

Correção: autenticação obrigatória; consentimento com nonce de uso único emitido
server-side, não um campo do payload.

### C2 · QR de pareamento exposto sem autenticação
`apps/api/src/server.ts:15-20` → `apps/worker/src/index.ts:24` → `apps/worker/src/whatsapp.ts:26,66`

O tipo declarado em `server.ts:11` é só uma anotação TypeScript — o JSON é repassado
inteiro, incluindo `qr` (data URL do QR) e `accountJid`.

Exploração: um processo local chama `POST /whatsapp/connect` e faz polling em
`GET /whatsapp/status`. Quem ler o QR **vincula o próprio aparelho à conta do titular**,
com acesso a mensagens e capacidade de enviar como ele. Persiste até a remoção manual
do aparelho no celular.

### C3 · Credenciais da sessão em texto claro dentro do OneDrive
`apps/worker/src/whatsapp.ts:24,42,99`

`.sessions/whatsapp/creds.json` contém `noiseKey`, `signedIdentityKey`, `signedPreKey`,
`advSecretKey`, `registrationId` e `signalIdentities` em texto claro. Esse conjunto **é** a
sessão: quem copia o diretório assume a conta sem QR e sem senha.

Três agravantes verificados:

1. O projeto está em `C:\Users\rafad\OneDrive\...`, então os segredos são replicados para
   a nuvem, para qualquer outro PC logado na mesma conta, e permanecem no histórico de
   versões do OneDrive **mesmo após exclusão local**.
2. `mkdir(..., { mode: 0o700 })` em `:42` **não tem efeito no Windows**. A ACL herdada é o
   único controle.
3. Sessões revogadas são retidas para sempre (`:99`). Existem hoje dois diretórios
   `-revoked-*`. O `logout()` em `:97` está num `catch` silencioso: se falhou, essas
   credenciais continuam válidas, no disco e na nuvem.

Correção: `.sessions/` e `.runtime/` fora da árvore sincronizada, caminho por variável de
ambiente; cifrar em repouso; apagar os `-revoked-*` e desvincular os aparelhos pelo celular.

---

## Alto

### A1 · Worker sem autenticação, com ações destrutivas
`apps/worker/src/index.ts:17-27`

O hook rejeita qualquer requisição **que tenha** header `Origin` (`:21`) — o que bloqueia
navegadores e libera integralmente clientes não-browser, que simplesmente não enviam
`Origin`. Via `curl`, sem passar pela API: `POST /disconnect` derruba a conexão e invalida
a sessão; `POST /sync` desativa grupos em massa; `POST /connect` gera o QR (encadeia com C2).

### A2 · Redis exposto na LAN sem senha
`docker-compose.yml:19-21`

`ports: "6379:6379"` faz bind em `0.0.0.0` e a imagem não define `requirepass`. Ao
contrário da API e do worker, **isto é alcançável pela rede local**. Um vizinho de rede
pode `DEL campaign:worker-owner` (o `leaseTimer` em `index.ts:86-89` recebe `!ok` e chama
`shutdown()` — o worker se desliga sozinho), ou `SET` a chave para impedir o boot, ou
`FLUSHALL`.

Injeção de jobs forjados **não** funciona: `claimDelivery` revalida tudo contra o banco
(`queue.ts:21-37`). O impacto é negação de serviço e adulteração de fila.

### A3 · O hook `onRequest` da API não é controle de acesso
`apps/api/src/server.ts:26-35`

Verificado empiricamente contra Fastify 5.12.5. O que **funciona** como defesa: o hook
cobre também as rotas declaradas antes dele; `request.hostname` exclui a porta
corretamente; DNS rebinding clássico é bloqueado; CSRF por `<form>` POST é bloqueado
porque o navegador envia `Origin`.

O que **contorna**:

1. **Host spoofing por cliente não-browser.** `curl -H "Host: localhost"` sem `Origin`
   passa nas duas checagens. O `Host` é 100% controlado pelo cliente.
2. **Túnel ou proxy que reescreve `Host`.** Se a API for exposta para acesso pelo celular
   (`ngrok --host-header=localhost`, Cloudflare Tunnel, `nginx proxy_set_header`), toda a
   proteção evapora — inclusive contra a internet.
3. **GET cross-site sem `Origin`.** `<img>`, `<script>`, `<video>` e navegação de topo não
   enviam `Origin`. Como `GET /campaigns` e `GET /campaigns/:id` chamam `completeFinished`,
   que executa `updateMany` alterando status (`queue.ts:8-14`), isso é **CSRF com efeito
   de escrita** via `<img src="http://127.0.0.1:3001/campaigns">`.
4. **Origem compartilhada.** `localhost:3000` é a porta mais disputada em
   desenvolvimento: qualquer outro projeto nessa porta, ou um XSS no painel, recebe acesso
   CORS total de leitura e escrita.

Tratar como defesa em profundidade, nunca como autenticação.

### A4 · Todos os dados expostos sem autenticação

`GET /deliveries` (`server.ts:61-72`) usa `findMany` **sem `select`** e devolve todos os
campos, incluindo **`messageBody`** — o conteúdo completo das mensagens — e `providerId`.
`GET /groups` (`:37`) entrega os JIDs reais. `GET /campaigns`, `GET /campaigns/:id`,
`GET /dashboard`, `GET /media/:id` e todas as rotas de escrita seguem o mesmo padrão.

### A5 · Amplificação de memória em mídia
`apps/api/src/media.ts:52,61,65,68`

- `bodyLimit: VIDEO_LIMIT` (64 MB) é aplicado **também** a `image/jpeg` e `image/png`; o
  limite real de 16 MB só é verificado em `:34`, depois do buffer de 64 MB já estar em
  memória.
- `new Uint8Array(data)` (`:61`) duplica o buffer: ~128 MB por requisição, sem limite de
  concorrência.
- No download, `findUnique` sem `select` (`:65`) traz os bytes e `Buffer.from` (`:68`)
  copia de novo — **inclusive para requisições `Range`**. Servir 1 byte de um vídeo de
  64 MB materializa 128 MB. Requisições `Range` paralelas derrubam a API a custo zero.
- Nenhuma rota do projeto tem rate limiting.

### A6 · Dependências vulneráveis
`npm audit --omit=dev`: 4 altas, 1 moderada, 0 críticas.

- **`postcss` ≤ 8.5.22** via `next` — quatro advisories: leitura arbitrária de arquivo e
  path traversal por `sourceMappingURL` (CVSS 7.5), XSS por `</style>` não escapado.
  Impacto real baixo aqui: o CSS é de origem confiável e processado em build-time. A
  correção exige `next@16` (major, breaking).
- **`deepmerge-ts` < 8.0.0** via `prisma` → `@prisma/config` — exaustão de pilha. Entrada
  controlada pelo próprio desenvolvedor, risco prático baixo. `npm audit fix` resolve sem
  breaking change.

---

## Médio

| # | Achado | Local |
|---|---|---|
| M1 | `ffprobe` nativo processa até 64 MB de bytes hostis. As mitigações presentes são boas (`-protocol_whitelist pipe`, `-f mov`, timeout, teto de stdout, nenhum argumento vindo do usuário — **não há injeção de comando**). O risco residual é memory-safety do FFmpeg. Falta `SIGKILL` de fallback após o `kill()`. | `media.ts:12-29` |
| M2 | `Bytes` no Postgres sem cota e **sem nenhuma rotina de exclusão** — não existe `campaignMedia.delete` em todo o repositório. Crescimento monotônico ilimitado. | `schema.prisma:116-125` |
| M3 | Mensagens de erro internas do Prisma/Baileys vazam para o cliente. `scripts/test-integration.cjs:15` já faz a redação correta da `DATABASE_URL`; os runtimes não. | `worker/index.ts:23`, `server.ts:120,172` |
| M4 | `mode: 0o700` inoperante no Windows. Reforça C3. | `whatsapp.ts:42` |
| M5 | Postgres em `0.0.0.0:5432`. Atenuante: a senha em uso é forte, não é o `change_this_password` do exemplo. | `docker-compose.yml:8-9` |
| M6 | Zero rate limiting em toda a API. Amplifica A5 e M1. | — |

---

## O que foi verificado e está correto

- **Nenhuma injeção SQL explorável.** Todos os `$queryRaw` usam tagged template, que o
  Prisma converte em query parametrizada. O `$executeRawUnsafe` de
  `scripts/test-integration.cjs:13,20` interpola um nome de schema gerado por
  `randomBytes` e validado por regex antes do uso — não há caminho de entrada externa.
  O padrão é frágil por construção (identificadores não podem ser parametrizados) e vale
  trocar por `Prisma.raw`, mas não é explorável.
- **O parsing de `Range` em `media.ts:69-75` não tem falha.** Sufixo, aberto, overflow e
  entradas malformadas foram conferidos caso a caso; `Number.isSafeInteger` e as guardas de
  `:73` barram leitura fora dos limites. O único desvio da RFC é `Range` multipart, que
  retorna 416 em vez de 200 — não é falha de segurança.
- **Sem XSS armazenado em `/media/:id`.** `X-Content-Type-Options: nosniff` presente e o
  `mimeType` é estruturalmente restrito a três valores.
- **`.env` e `.sessions/` nunca foram commitados** — `git log --all` sobre esses caminhos
  retorna vazio. O `.gitignore` cobre corretamente. A ressalva é o OneDrive, não o Git.
- `recordRead` recusa associações ambíguas, evitando atribuir leitura à campanha errada.

---

## Ordem de maior alavancagem

1. **Token de autenticação obrigatório na API e no worker** — resolve ou reduz C1, C2, A1,
   A4 e A5 de uma vez.
2. **Tirar `.sessions/` e `.env` do OneDrive; apagar os `-revoked-*` e desvincular os
   aparelhos pelo celular** — resolve C3.
3. **Bind de Redis e Postgres em `127.0.0.1` e `requirepass` no Redis** — resolve A2 e M5.
