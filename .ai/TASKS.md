# TASKS — backlog com dono declarado

> **Protocolo de lock:** reivindique antes de editar código. Veja `AGENTS.md`, Seção 2.
>
> `[ ]` aberta · `[~]` em andamento · `[x]` concluída · `[!]` bloqueada
>
> `owner` é `claude`, `codex` ou `—`. `since` é UTC ISO-8601 (`2026-09-20T18:40Z`).
> Lock com mais de 24h está expirado e pode ser assumido — registre isso no handoff.

---

## Urgente — achados da auditoria de 2026-09-20

Severidade entre parênteses. C = crítico, A = alto, M = médio. Detalhe completo em
`docs/security-audit-2026-09.md`.

```
[x] T-040  (C) Mover .sessions/ para fora do OneDrive, via env  owner: —        since: —
[ ] T-041  (C) Apagar sessoes -revoked-* e desvincular aparelhos  owner: —        since: —
[ ] T-042  (C) Token de autenticação obrigatório na API          owner: —        since: —
[ ] T-043  (C) Parar de serializar o QR sem autenticação         owner: —        since: —
[ ] T-044  (A) Token compartilhado no worker (porta 3002)        owner: —        since: —
[ ] T-045  (A) Bind de Postgres e Redis em 127.0.0.1             owner: —        since: —
[x] T-046  (A) requirepass no Redis — resolvido: Redis removido     owner: —        since: —
[ ] T-047  (A) select explícito em /deliveries (vaza messageBody)  owner: —       since: —
[ ] T-048  (A) bodyLimit por tipo e streaming de mídia           owner: —        since: —
[ ] T-049  (A) npm audit fix para deepmerge-ts via prisma        owner: —        since: —
[ ] T-050  (M) Mapear erros internos antes de responder          owner: —        since: —
[ ] T-051  (M) rate limiting na API                              owner: —        since: —
[ ] T-052  (M) Rotina de exclusão de mídia órfã e cota           owner: —        since: —
[ ] T-053  (M) SIGKILL de fallback no timeout do ffprobe         owner: —        since: —
```

## Fase 1 — Endurecimento

```
[x] T-001  Protocolo multi-agente (AGENTS.md, CLAUDE.md, .ai/)   owner: —        since: —      
[x] T-002  Limpeza de artefatos e docs mortos                     owner: —        since: —      
[x] T-003  Auditoria de segurança da superfície atual             owner: —        since: —      
[ ] T-004  Validação declarativa com Zod em apps/api              owner: —        since: —
[ ] T-005  Logs estruturados (pino) + request id nos 3 serviços   owner: —        since: —
[ ] T-006  CI no GitHub Actions: lint + test + build              owner: —        since: —
[ ] T-007  Quebrar linhas de 400+ chars nos arquivos tocados      owner: —        since: —
```

## Fase 2 — Contas e autenticação

```
[ ] T-010  ADR: estratégia de isolamento multi-tenant             owner: —        since: —
[ ] T-011  Modelo Organization / User / Membership no Prisma      owner: —        since: —
[ ] T-012  Migration + backfill de organização padrão             owner: —        since: —
[ ] T-013  Autenticação por sessão (cookie httpOnly)              owner: —        since: —
[ ] T-014  Papéis e autorização por rota                          owner: —        since: —
[ ] T-015  Escopar todas as queries por organizationId            owner: —        since: —
[ ] T-016  Telas de login, cadastro e troca de organização        owner: —        since: —
```

## Fase 3 — Múltiplas sessões de WhatsApp

```
[ ] T-020  Modelo WhatsAppSession + migration                     owner: —        since: —
[ ] T-021  Tornar WhatsAppProvider instanciável por sessão        owner: —        since: —
[ ] T-022  Group.externalId único por sessão, não global          owner: —        since: —
[ ] T-023  Fila BullMQ por sessão, remover lock global do worker  owner: —        since: —
[ ] T-024  Criptografar credenciais de sessão em repouso          owner: —        since: —
```

## Fase 4 — Operação

```
[ ] T-030  Mover mídia do Postgres para storage de objetos        owner: —        since: —
[ ] T-031  Backup automatizado e procedimento de restauração      owner: —        since: —
[ ] T-032  Health checks e métricas                               owner: —        since: —
[ ] T-033  Deploy reprodutível (Dockerfile por serviço)           owner: —        since: —
```

## Fase 1b — Inicialização local

```
[x] T-071  Executável de duplo clique com pré-voo e build incremental   owner: —        since: —
[x] T-072  Lease do worker sem armadilha de fuso, com teste             owner: —        since: —
[ ] T-073  Ícone e assinatura do .exe (evita aviso do SmartScreen)      owner: —        since: —
```

## Fase 5 — Deploy em VPS

```
[ ] T-060  Config por env: hosts/origens/URL da API (remover hardcode de localhost)  owner: —        since: —
[ ] T-061  Web fala com a API por rota same-origin (/api), sem NEXT_PUBLIC_API_URL   owner: —        since: —
[ ] T-062  Dockerfile multi-stage por serviço (api, worker, web)                     owner: —        since: —
[ ] T-063  docker-compose.prod.yml: rede interna, sem portas de DB/Redis publicadas   owner: —        since: —
[ ] T-064  Caddy como reverse proxy com HTTPS automático                              owner: —        since: —
[ ] T-065  Remover ReferenceClock; usar NTP do host e now() do Postgres              owner: —        since: —
[x] T-066  Trocar BullMQ/Redis por fila em Postgres                  owner: —        since: —
[ ] T-067  Migrations no release (migrate deploy) e healthchecks reais               owner: —        since: —
[ ] T-068  Backup diário do Postgres + volume de sessões, com restore testado        owner: —        since: —
[ ] T-069  CI/CD: build de imagens no GitHub Actions e deploy por SSH                owner: —        since: —
[ ] T-070  Hardening da VPS: firewall, SSH por chave, fail2ban, updates automáticos  owner: —        since: —
```

---

## Regras

- **Não crie tarefa duplicada.** Procure antes de adicionar.
- IDs são sequenciais e **nunca reutilizados**, mesmo após conclusão.
- Tarefa bloqueada (`[!]`) precisa de uma linha explicando o que a desbloqueia.

## Simplificação para processo único

```text
[x] T-074  Fundir API e worker em servidor único Fastify           owner: —        since: —
[~] T-075  Migrar o painel de Next.js para Vite na mesma origem     owner: codex    since: 2026-09-21T01:00Z
```
