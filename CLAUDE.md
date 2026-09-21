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
- Banco: MySQL 8 nativo (serviço `MySQL80`), sem Docker nem Redis. `npm run db:check` diagnostica.
- `npm run start:local` sobe o servidor (3001, API em `/api`) e o painel (3000). Use `npm.cmd` no PowerShell.
- Testes que **não** precisam de WhatsApp: `npm test`.
- Teste de integração (cria e destrói um banco MySQL aleatório): `npm run test:integration`.
- MySQL usa REPEATABLE READ: toda transação com `lockCampaign` precisa de `LOCKING_TRANSACTION` (ADR-010).

### Antes de encerrar

```bash
npm run ai:check
```

Falhou? Corrija. Esse comando verifica que o ritual de encerramento foi cumprido.
