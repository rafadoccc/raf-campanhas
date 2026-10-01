import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Field, IconMention, inputClass } from '../design';

// Caixa da mensagem com prévia ao vivo no jeito do WhatsApp (ADR-039): *negrito*, _itálico_,
// ~riscado~ e ```monoespaçado``` já formatados, e o @todos em azul no lugar onde vai sair. A
// posição do @todos segue a mesma regra do servidor (withMentionAllToken): onde a pessoa escreveu
// "@todos"/"@all"/"@everyone"; se não escreveu, no começo.

const MENTION_ALL_WORD = /(^|[\s(])@(todos|all|everyone)(?![\p{L}\p{N}_])/iu;
const MENTION_TOKEN = '\u0000todos\u0000'; // marca interna do lugar do @todos na prévia

/** Onde o @todos vai aparecer: mesma regra do servidor. */
function placeMentionAll(text: string) {
  if (MENTION_ALL_WORD.test(text)) return text.replace(MENTION_ALL_WORD, (_m, lead: string) => `${lead}${MENTION_TOKEN}`);
  return text ? `${MENTION_TOKEN} ${text}` : MENTION_TOKEN;
}

// Formatação do WhatsApp dentro de uma linha. O marcador precisa encostar no texto
// (ex.: "*oi*" formata, "* oi *" não), como no aplicativo.
const FORMAT = /(```[^`]+```|\*[^\s*](?:[^*\n]*[^\s*])?\*|_[^\s_](?:[^_\n]*[^\s_])?_|~[^\s~](?:[^~\n]*[^\s~])?~|\u0000todos\u0000)/g;

function renderLine(line: string, key: string): ReactNode[] {
  return line.split(FORMAT).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`;
    if (part === MENTION_TOKEN) return <span key={k} className="font-medium text-sky-600">@todos</span>;
    if (part.startsWith('```') && part.endsWith('```') && part.length > 6) return <code key={k} className="font-mono text-[0.85em]">{part.slice(3, -3)}</code>;
    if (part.length > 2 && part[0] === part[part.length - 1]) {
      const inner = part.slice(1, -1);
      if (part[0] === '*') return <strong key={k}>{inner}</strong>;
      if (part[0] === '_') return <em key={k}>{inner}</em>;
      if (part[0] === '~') return <s key={k}>{inner}</s>;
    }
    return <span key={k}>{part}</span>;
  });
}

/** Uma linha de texto limpo, sem os marcadores (*negrito*, _itálico_…), para resumos. */
export function plainSummary(text: string) {
  return text
    .replace(/```([^`]+)```/g, '$1')
    .replace(/([*_~])(\S(?:[^*_~\n]*\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Balão no jeito do WhatsApp, com a formatação e o @todos (usado no editor e no detalhe). */
export function WhatsAppPreview({ text, mentionAll }: { text: string; mentionAll: boolean }) {
  const shown = mentionAll ? placeMentionAll(text) : text;
  return <div className="rounded-md bg-[#efeae2] p-3">
    <div className="ml-auto w-fit max-w-full rounded-lg rounded-tr-sm bg-[#d9fdd3] px-3 py-2 text-sm text-ink shadow-sm">
      {shown.trim()
        ? shown.split('\n').map((line, i) => <p key={i} className="min-h-[1.25rem] whitespace-pre-wrap break-words">{renderLine(line, String(i))}</p>)
        : <p className="text-slate-400">A prévia aparece aqui enquanto você escreve.</p>}
    </div>
  </div>;
}

type Props = {
  label: string;
  defaultValue: string;
  /** Marcar todos ligado na campanha: a prévia mostra o @todos. */
  mentionAll: boolean;
  /** Inserir @todos liga a opção (sem ela, o @todos iria como texto comum). */
  onMentionAll: (value: boolean) => void;
};

export function MessageEditor({ label, defaultValue, mentionAll, onMentionAll }: Props) {
  const [value, setValue] = useState(defaultValue);
  const area = useRef<HTMLTextAreaElement>(null);
  // Rascunho carregado depois (editar campanha): a caixa acompanha o valor salvo.
  useEffect(() => { setValue(defaultValue); }, [defaultValue]);

  /** Troca a seleção (ou insere no cursor) mantendo o foco e o cursor no lugar certo. */
  function apply(transform: (selected: string) => string) {
    const el = area.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const inserted = transform(value.slice(start, end));
    const next = value.slice(0, start) + inserted + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const cursor = start + inserted.length;
      el.setSelectionRange(cursor, cursor);
    });
  }
  const wrap = (mark: string) => apply(selected => `${mark}${selected || 'texto'}${mark}`);
  const insertMentionAll = () => {
    apply(() => {
      const el = area.current;
      const before = value.slice(0, el?.selectionStart ?? value.length);
      return `${before && !/\s$/.test(before) ? ' ' : ''}@todos `;
    });
    onMentionAll(true);
  };
  const toolButton = 'inline-flex h-7 min-w-[1.75rem] items-center justify-center gap-1 rounded px-2 text-xs text-muted transition-colors hover:bg-slate-100 hover:text-ink';

  const typedMention = MENTION_ALL_WORD.test(value);
  return <div className="space-y-2">
    <Field label={label}>
      <textarea ref={area} value={value} onChange={event => setValue(event.target.value)} required maxLength={10000} name="message" className={`${inputClass} min-h-28`} />
    </Field>
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className={`${toolButton} font-bold`} title="Negrito (*texto*)" aria-label="Negrito" onClick={() => wrap('*')}>B</button>
      <button type="button" className={`${toolButton} italic`} title="Itálico (_texto_)" aria-label="Itálico" onClick={() => wrap('_')}>I</button>
      <button type="button" className={`${toolButton} line-through`} title="Riscado (~texto~)" aria-label="Riscado" onClick={() => wrap('~')}>S</button>
      <button type="button" className={`${toolButton} font-medium text-sky-700`} title="Marca todos do grupo onde está o cursor" onClick={insertMentionAll}>
        <IconMention className="h-3.5 w-3.5" aria-hidden />Inserir @todos
      </button>
    </div>
    <div>
      <p className="mb-1 text-2xs font-medium text-muted">Prévia no WhatsApp</p>
      <WhatsAppPreview text={value} mentionAll={mentionAll} />
      {mentionAll && <p className="mt-1 text-2xs text-slate-400">O @todos aparece no idioma de cada celular (@todos ou @all). Em grupos com mais de 32 membros onde você não é admin, ele vai oculto.</p>}
      {!mentionAll && typedMention && <p className="mt-1 text-2xs text-amber-700">Você escreveu @todos, mas "Marcar todos" está desligado: vai como texto comum, sem notificar. Ligue a opção acima.</p>}
    </div>
  </div>;
}
