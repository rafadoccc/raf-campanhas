# AGENTS.md — Contrato obrigatório para agentes de IA

> **Este arquivo é normativo.** Claude Code, Codex CLI e qualquer outro agente que
> escreva neste repositório DEVEM seguir o procedimento abaixo. Humanos podem ignorá-lo.
>
> Codex lê `AGENTS.md` automaticamente. Claude Code lê `CLAUDE.md`, que importa este arquivo.
> Os dois convergem aqui: **há uma única fonte de verdade.**

---

## 0. Por que este arquivo existe

Este repositório é editado por **mais de um agente de IA**, em sessões separadas, que
não compartilham memória. Sem um protocolo, o resultado é: decisões contraditórias,
refatorações que se desfazem mutuamente, e trabalho duplicado.

O canal de comunicação entre os agentes **é o próprio repositório**. Não existe outro.
Se não está escrito em `.ai/`, não aconteceu.

---

## 1. Ritual de abertura (OBRIGATÓRIO, antes de qualquer edição)

Execute, na primeira ação da sessão:

```bash
npm run ai:brief
```

Esse comando imprime: estado atual do projeto, tarefas abertas e seus donos, as últimas
entradas de handoff e os commits recentes. **Leia a saída inteira antes de propor qualquer
coisa.** Se o comando falhar, leia manualmente, nesta ordem:

1. `.ai/STATE.md` — onde o projeto está agora (arquitetura, fase, o que está quebrado)
2. `.ai/TASKS.md` — backlog com dono declarado
3. `.ai/DECISIONS.md` — decisões arquiteturais já fechadas (ADRs)
4. `.ai/HANDOFF.md` — as 3 entradas mais recentes
5. `git log --oneline -15`

**Nunca reabra uma decisão registrada em `.ai/DECISIONS.md` sem autorização explícita
do usuário humano.** Se você discorda de uma ADR, escreva sua objeção no handoff e
pergunte ao humano. Não a implemente ao contrário silenciosamente.

---

## 2. Reivindicação de tarefa (lock cooperativo)

Antes de escrever código, **reivindique a tarefa** em `.ai/TASKS.md` editando a linha:

```
- [ ] T-012  Extrair validação para Zod          owner: —        since: —
```

para:

```
- [~] T-012  Extrair validação para Zod          owner: claude   since: 2026-09-20T18:40Z
```

Regras do lock:

| Situação | O que fazer |
|---|---|
| Tarefa com `owner: —` | Pode reivindicar. |
| Tarefa com `owner: <outro agente>` e `since` < 24h | **NÃO TOQUE.** Escolha outra ou pergunte ao humano. |
| Tarefa com `owner: <outro agente>` e `since` > 24h | Lock expirado. Pode assumir, mas **registre no handoff** que assumiu um lock expirado. |
| Tarefa que não existe no arquivo | Crie a entrada primeiro, com ID novo, e só então reivindique. |

Ao terminar, marque `[x]` e limpe o owner para `—`.

Os identificadores são **`claude`** e **`codex`**. Use exatamente esses nomes, minúsculos.

---

## 3. Ritual de encerramento (OBRIGATÓRIO, antes de terminar a sessão)

1. Atualize `.ai/STATE.md` se a arquitetura, a fase ou o conjunto de serviços mudou.
2. Se você tomou uma decisão arquitetural, adicione uma ADR em `.ai/DECISIONS.md`.
3. **Sempre** acrescente uma entrada no topo de `.ai/HANDOFF.md` no formato da Seção 4.
4. Rode `npm run ai:check`. Se falhar, corrija antes de encerrar.

Uma sessão que alterou código e **não** deixou entrada de handoff é uma violação do
contrato. O próximo agente vai encontrar mudanças órfãs e desfazê-las.

---

## 4. Formato da entrada de handoff

Entradas novas vão **no topo** do arquivo, logo abaixo do cabeçalho. Nunca edite
entradas antigas — o arquivo é append-only.

```markdown
## 2026-09-20T18:40Z · claude

**Fiz:** frase curta e concreta do que mudou.
**Arquivos:** caminho/a.ts, caminho/b.ts
**Tarefas:** T-012 (concluída), T-013 (em andamento)
**Estado:** compila / não compila · testes passam / falham (quais)
**Armadilhas:** o que o próximo agente precisa saber para não quebrar isso.
**Próximo passo sugerido:** uma ação específica, não um objetivo vago.
```

---

## 5. Convenção de commit

Mensagens seguem [Conventional Commits](https://www.conventionalcommits.org/):
`feat(api): ...`, `fix(worker): ...`, `refactor(db): ...`, `chore: ...`, `docs: ...`.
Assunto em inglês, imperativo, sem ponto final.

**Não assine commits nem PRs com identificação de IA.** Nada de trailers
`Co-Authored-By`, `Generated with` ou equivalentes. O histórico do Git pertence ao autor
humano do projeto. A rastreabilidade entre agentes vive em `.ai/HANDOFF.md`, que
referencia o SHA do commit — isso basta para a coordenação e não vaza para o repositório
público.

Commit e push direto em `main` estão autorizados pelo dono do repositório
(`https://github.com/rafadoccc/raf-campanhas`). Ainda assim:

- rode `npm run lint` antes de commitar;
- **nunca** faça commit de `.env`, `.sessions/`, `outputs/` ou qualquer credencial;
- um commit por unidade lógica de mudança, não um despejo de fim de sessão.

## 6. Regras de engenharia (valem para os dois agentes)

1. **Não reescreva o que funciona.** A lógica de fila em `packages/database/src/queue.ts`
   e o planejador em `apps/api/src/schedule.ts` são cuidadosamente corretos quanto a
   concorrência e idempotência. Mudanças ali exigem ADR.
2. **Uma linha, uma ideia.** O código legado usa linhas de 400+ caracteres com múltiplos
   `?:` aninhados. Código novo não faz isso. Ao tocar em um arquivo denso, quebre apenas
   o trecho que você já está alterando — não faça reformatação em massa (gera conflito
   com o outro agente).
3. **Nada de mudança silenciosa de contrato.** Se mudar a forma de uma resposta HTTP ou
   o schema Prisma, registre em `.ai/DECISIONS.md` e avise no handoff.
4. **Migrations são aditivas.** Nunca edite uma migration já aplicada. Sempre crie uma nova.
5. **Sem segredos no repositório.** `.env`, `.sessions/` e credenciais ficam fora do Git.
   Se encontrar um segredo versionado, pare e avise o humano.
6. **Teste antes de declarar pronto.** `npm run lint` e `npm test` precisam passar.
   Se falharem por motivo preexistente, diga isso explicitamente no handoff.
7. **Mensagens de UI em português do Brasil.** Nomes de código, tipos e commits em inglês.

---

## 7. Divisão de trabalho sugerida

Não é rígida, mas reduz colisão quando os dois agentes trabalham no mesmo dia:

| Área | Dono preferencial |
|---|---|
| `packages/database/`, migrations, modelagem | claude |
| `apps/api/` — rotas, validação, contratos | claude |
| `apps/web/` — UI, componentes, estilos | codex |
| `apps/worker/` — Baileys, fila, conector | claude |
| Testes, scripts, CI | qualquer um — reivindique a tarefa |
| Documentação em `docs/` | quem fez a mudança correspondente |

Se precisar entrar na área do outro, reivindique a tarefa e diga no handoff.

---

## 8. Resolução de conflito entre agentes

Se você encontrar código que contradiz uma ADR ou o STATE:

1. **Não desfaça.** Pode ser trabalho em andamento do outro agente.
2. Verifique `.ai/TASKS.md` — existe lock ativo naquela área?
3. Registre a divergência no handoff, em **Armadilhas**, e pergunte ao humano.

O humano decide. Agentes não têm autoridade um sobre o outro.
