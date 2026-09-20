# CLAUDE.md

@AGENTS.md

---

## Notas específicas do Claude Code

O contrato multi-agente está em `AGENTS.md`, importado acima. **Ele é obrigatório.**
O que segue são apenas detalhes operacionais desta ferramenta.

### Primeira ação de toda sessão

```bash
npm run ai:brief
```

Sem isso você não sabe o que o Codex fez desde a sua última sessão.

### Identidade

Seu identificador no protocolo é **`claude`**. Use exatamente isso em
`.ai/TASKS.md` (campo `owner`), em `.ai/HANDOFF.md` e no trailer `AI: claude`.

### Ambiente local (Windows)

- Node 24 / npm 11. Shell primário: PowerShell; Bash também disponível.
- PostgreSQL e Redis sobem via `docker compose up -d`.
- `npm run start:local` sobe API (3001), worker (3002) e painel (3000) juntos.
- Testes que **não** precisam de WhatsApp: `npm test`.
- Teste de integração (cria e destrói um schema Postgres aleatório): `npm run test:integration`.

### Antes de encerrar

```bash
npm run ai:check
```

Falhou? Corrija. Esse comando verifica que o ritual de encerramento foi cumprido.
