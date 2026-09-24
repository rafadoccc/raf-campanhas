# Design system do painel

Tudo em `apps/web/src/design/` (`export * from` num único `index.ts`). As telas importam só
daqui — nunca montam botão, selo, ícone, `<select>` ou caixa de marcação por conta própria.
Cantos sempre 5–6 px (`tailwind.config.ts`: `DEFAULT/md 5px`, `lg/xl/2xl 6px`); `rounded-full`
fica só para o ponto de status (`Dot`). Uma ação primária por área; o resto é secundário
(`Button` sem `variant`) ou discreto (`variant="ghost"`).

## Peças (`primitives.tsx`)

| Peça | Uso |
|---|---|
| `Button` / `ButtonLink` / `IconButton` | `variant`: `primary` (uma por área), `secondary` (padrão), `ghost`, `danger`. `size`: `sm`/`md`. `IconButton` é só ícone, com `label` obrigatório (leitor de tela e `title`). |
| `Card` / `CardHeader` | Bloco com borda fina e sombra quase nula (`shadow-card`). Sem faixa colorida, sem borda decorativa — cor de imagem só aparece na miniatura e na barra de progresso, nunca como moldura do cartão. |
| `Badge` | Selo de estado (`Tone`: `neutral`, `brand`, `info`, `warning`, `danger`, `muted`). |
| `Dot` | Ponto de status (`ok`/`warn`/`busy`/`off`). Único elemento redondo do sistema. |
| `Field` / `inputClass` | Rótulo + dica para campos de texto/número/data nativos (esses continuam nativos: só select e checkbox têm peça própria). |
| `PasswordInput` | Campo de senha com o botão de mostrar/esconder. Use sempre no lugar de `<input type="password">`. |
| `Select` | Ver abaixo. |
| `Checkbox` | Ver abaixo. |
| `Alert` | Aviso inline (`tone`: `danger`/`warning`/`info`/`brand`). |
| `EmptyState` / `Skeleton` | Lista vazia e carregamento. |
| `ScrollArea` | `overflow-y: auto` com barra invisível (`.scroll-area` em `styles.css`); a rolagem por roda/toque/teclado continua funcionando. Use dentro de um contêiner de altura definida — é assim que cada tela rola por partes em vez do documento inteiro (`Page` ocupa `h-full`, sem rolagem própria). |
| `Stat` | Número grande com rótulo e ícone, usado nas faixas de métricas (Início, Administração). |
| `PageHeader` / `Page` | Cabeçalho e moldura da página. `Page` sem opção: altura da tela no desktop, listas rolando por dentro (Início, Campanhas, detalhe). `<Page scroll>`: a página cresce e rola inteira (telas de seções empilhadas, como Administração). No celular toda página rola inteira. Grades com colunas que rolam por dentro precisam de `lg:grid-rows-[minmax(0,1fr)]`, senão a coluna cresce e a parte de baixo é cortada. |

## `Select` — sem o menu nativo do sistema operacional

Botão + lista flutuante desenhada pelo app (`role="listbox"`/`role="option"`), não um
`<select>` do navegador: no Windows/Mac o menu nativo não pode ser restilizado, então usar
`<select>` sempre vaza a aparência do sistema operacional.

```tsx
<Select label="Papel" value={role} onChange={setRole}
  options={[{ value: 'USER', label: 'Usuário' }, { value: 'SUPER_ADMIN', label: 'Administrador' }]} />
```

- Teclado completo: `ArrowUp`/`ArrowDown` navega, `Home`/`End` vai às pontas, `Enter`/`Espaço`
  escolhe, `Esc` fecha, `Tab` fecha e segue. Clique fora fecha (`mousedown` fora da raiz).
- `name` grava um `<input type="hidden">` — só necessário quando o formulário lê por
  `FormData` (a maioria das telas usa estado controlado e manda o valor direto no `json` do
  `api()`, e aí `name` não é preciso).

## `Checkbox` — `appearance-none` sobre `<input>` nativo

```tsx
<Checkbox checked={mentionAll} onChange={setMentionAll} label="Marcar todos os membros (@todos)"
  hint="Cada participante do grupo recebe notificação de menção." />
```

O `<input type="checkbox">` continua nativo por baixo (teclado, leitor de tela e formulários
de graça) — só o visual muda, com `appearance-none` mais um `<span>` com o ícone de marcado
por cima (`peer-checked:opacity-100`). Por isso é mais simples e mais robusto que reconstruir
um checkbox do zero em ARIA: o comportamento nunca diverge do nativo, só o desenho.

## Ícones (`icons.ts`)

Só `lucide-react`, importados com nomes semânticos (`IconEdit`, `IconDelete`, `IconRefresh`…) —
**nunca** setas de texto (`→ ← ↑ ↓ ×`): o mesmo gesto usa o mesmo ícone em toda tela. Adicionar
um ícone novo é um `import { X as IconY } from 'lucide-react'` a mais nesse arquivo; a mesma
importação lucide pode ganhar dois nomes semânticos diferentes quando o ícone serve dois papéis
(ex.: `ChevronDown` é `IconMoveDown`, usado para reordenar, e também `IconChevron`, usado como
seta do `Select`).

## Formatos e cor de destaque (`format.ts`)

`hora`/`horaSeg`/`dataHora`/`dia` (sempre America/Sao_Paulo, exceto `dia` que é UTC — datas de
campanha são gravadas como meia-noite UTC do dia escolhido), `numero`, `tamanho`, `membros`,
`tempoRelativo`, `campaignStatus`, `deliveryStatus`. `accent(color)` deriva a cor de destaque da
cor predominante da imagem da campanha (ADR-026): escurece até ter contraste sobre branco: usada
só na miniatura, na barra de progresso e em selos pontuais — nunca como moldura do cartão
inteiro (ADR de limpeza visual, ver "bordas decorativas" abaixo).

## Bordas decorativas — removidas de propósito

O sistema teve, e não tem mais: faixa colorida na lateral do cartão de campanha, borda do
cartão na cor da imagem, e uma barra colorida no topo do cartão de detalhe. Eram só
decoração (nenhuma delas carregava informação que a mensagem de status ou a barra de
progresso já não dessem) e ficaram de fora deliberadamente — visual limpo, direto,
funcional. Ao adicionar uma tela nova, **não** reintroduza esse tipo de elemento; se a cor da
mídia precisar aparecer, use a miniatura ou a barra de progresso, do jeito que `campaigns.tsx`
e `campaign-detail.tsx` já fazem.

## Utilitários de interação

- **`ConfirmProvider`/`useConfirm`** (`confirm.tsx`): substitui o `confirm()` do navegador por
  um diálogo próprio (mesmo visual em todo o sistema, foco no botão seguro, `Esc` cancela).
  Toda ação irreversível ou de risco passa por aqui — nunca `window.confirm`.
- **`useInfiniteList`/`LoadMoreSentinel`** (`infinite.tsx`): rolagem infinita por cursor
  (`IntersectionObserver` no sentinela no fim da lista). Usado em Campanhas e nos Envios do
  detalhe da campanha.

## Layout de app

`main.tsx`: shell `h-dvh` (a altura da viewport, não a do documento — evita o salto do
teclado virtual no celular), menu fixo no topo, conteúdo abaixo ocupa o resto e cada tela
decide o que rola dentro de si (`ScrollArea`), nunca o documento inteiro. Rotas menos usadas
carregam sob demanda (`React.lazy`). `ConfirmProvider` envolve a árvore inteira, uma vez.
