import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ComponentType, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { IconCheck, IconChevron, IconEmpty, IconHide, IconLoading, IconMore, IconShow } from './icons';

// Peças básicas do design system (docs/design-system.md). Cantos de 5–6 px, borda fina,
// sombra quase nula. Uma ação principal por área; o resto é secundário ou discreto.

export type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

// active:scale dá um retorno tátil sutil ao clique (não anima quando desabilitado ou parado
// no teclado, só no clique de verdade — :active não dispara em foco nem em disabled).
const base = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded font-medium transition-all duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-line bg-white text-ink hover:bg-slate-50',
  ghost: 'text-muted hover:bg-slate-100 hover:text-ink',
  danger: 'text-red-700 hover:bg-red-50',
};
const sizes: Record<Size, string> = { sm: 'h-8 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm' };
export const buttonClass = (variant: Variant = 'secondary', size: Size = 'md', extra = '') => `${base} ${variants[variant]} ${sizes[size]} ${extra}`;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: Icon; loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon: IconCmp, loading, children, className = '', type = 'button', ...rest }, ref) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
    {loading ? <IconLoading className="h-4 w-4 animate-spin" aria-hidden /> : IconCmp && <IconCmp className="h-4 w-4" aria-hidden />}
    {children}
  </button>;
});

export function ButtonLink({ variant = 'secondary', size = 'md', icon: IconCmp, children, className = '', ...rest }: LinkProps & { variant?: Variant; size?: Size; icon?: Icon }) {
  return <Link className={buttonClass(variant, size, className)} {...rest}>{IconCmp && <IconCmp className="h-4 w-4" aria-hidden />}{children}</Link>;
}

/** Botão só com ícone: o rótulo vai para leitores de tela e para a dica ao passar o mouse. */
export function IconButton({ icon: IconCmp, label, variant = 'ghost', size = 'sm', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string; variant?: Variant; size?: Size }) {
  return <button type="button" aria-label={label} title={label} className={`${base} ${variants[variant]} ${size === 'sm' ? 'h-8 w-8' : 'h-9 w-9'} ${className}`} {...rest}>
    <IconCmp className="h-4 w-4" aria-hidden />
  </button>;
}

export function Card({ children, className = '', as: Tag = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'li' | 'article' }) {
  return <Tag className={`rounded-lg border border-line bg-white shadow-card ${className}`}>{children}</Tag>;
}

export function CardHeader({ title, action, className = '' }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return <div className={`flex items-center justify-between gap-3 border-b border-line px-4 py-3 ${className}`}><h2 className="text-sm font-semibold">{title}</h2>{action}</div>;
}

export type Tone = 'neutral' | 'brand' | 'info' | 'warning' | 'danger' | 'muted';
const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  brand: 'bg-brand-50 text-brand-700',
  info: 'bg-sky-50 text-sky-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  muted: 'bg-slate-50 text-slate-500',
};
export function Badge({ tone = 'neutral', title, children, className = '' }: { tone?: Tone; title?: string; children: ReactNode; className?: string }) {
  // transition-colors: um selo que muda de status durante a atualização automática da tela
  // (ex.: "Enviando" → "Entregue") troca de cor suavemente, em vez de piscar.
  return <span title={title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide transition-colors duration-300 ${tones[tone]} ${className}`}>{children}</span>;
}

/** Ponto de status (o único elemento redondo do sistema). */
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'busy' | 'off' }) {
  const color = { ok: 'bg-brand-500', warn: 'bg-amber-500', busy: 'bg-sky-500', off: 'bg-slate-300' }[tone];
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

export const inputClass = 'block w-full rounded border border-line bg-white px-2.5 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';

/** Campo de senha com o "olhinho" para mostrar/esconder o que foi digitado. */
export function PasswordInput({ className = '', ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? IconHide : IconShow;
  return <div className={`relative ${className}`}>
    <input {...rest} type={visible ? 'text' : 'password'} className={`${inputClass} pr-9`} />
    <button type="button" onClick={() => setVisible(v => !v)} aria-label={visible ? 'Esconder senha' : 'Mostrar senha'} title={visible ? 'Esconder senha' : 'Mostrar senha'} aria-pressed={visible}
      className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r text-slate-400 hover:text-ink">
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  </div>;
}

export type SelectOption = { value: string; label: string };
/**
 * Seletor próprio (nada do menu nativo do sistema operacional): botão + lista flutuante,
 * navegável por teclado (setas, Home/End, Enter/Espaço, Esc) e por clique. `name` grava um
 * campo oculto para formulários que leem por `FormData`.
 */
export function Select({ value, onChange, options, label, name, disabled, className = '' }: {
  value: string; onChange: (value: string) => void; options: SelectOption[]; label?: string; name?: string; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    const onPointerDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, options, value]);

  function choose(index: number) {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); setOpen(true); }
      return;
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    else if (event.key === 'Tab') setOpen(false);
  }

  return <div ref={root} className={`relative ${className}`}>
    {name && <input type="hidden" name={name} value={value} />}
    <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} disabled={disabled}
      onClick={() => setOpen(o => !o)} onKeyDown={onKeyDown}
      className={`${inputClass} flex items-center justify-between gap-2 text-left ${disabled ? '' : 'cursor-pointer'}`}>
      <span className="truncate">{current?.label ?? ''}</span>
      <IconChevron className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
    </button>
    {open && <ul role="listbox" tabIndex={-1} aria-label={label}
      className="absolute z-20 mt-1 max-h-60 w-full min-w-max origin-top animate-pop-in overflow-auto rounded border border-line bg-white py-1 text-sm shadow-pop">
      {options.map((option, index) => <li key={option.value} role="option" aria-selected={option.value === value}
        onMouseEnter={() => setActive(index)} onClick={() => choose(index)}
        className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 ${index === active ? 'bg-brand-50 text-brand-700' : ''} ${option.value === value ? 'font-medium' : ''}`}>
        <span className="truncate">{option.label}</span>
        {option.value === value && <IconCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      </li>)}
    </ul>}
  </div>;
}

export type MenuItem = { label: string; icon?: Icon; onSelect: () => void; danger?: boolean; disabled?: boolean };
/**
 * Menu de ações ("⋯"): agrupa as ações secundárias de uma linha para ela não virar uma fileira
 * de botões. Mesmo comportamento do `Select`: setas, Home/End, Enter/Espaço, Esc, clique fora.
 */
export function Menu({ items, label, disabled, trigger, triggerClassName, header }: {
  items: MenuItem[]; label: string; disabled?: boolean;
  /** Conteúdo do botão no lugar do "⋯" (ex.: ícone e nome do usuário no menu do topo). */
  trigger?: ReactNode; triggerClassName?: string;
  /** Linha de contexto no alto da lista (ex.: nome e e-mail de quem está logado). */
  header?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    list.current?.focus();
    const onPointerDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function choose(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    setOpen(false);
    item.onSelect();
  }
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(items.length - 1, i + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
    else if (event.key === 'End') { event.preventDefault(); setActive(items.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); setOpen(false); root.current?.querySelector('button')?.focus(); }
  }

  return <div ref={root} className="relative">
    {trigger
      ? <button type="button" aria-label={label} title={label} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} className={triggerClassName}>{trigger}</button>
      : <IconButton icon={IconMore} label={label} variant="secondary" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} />}
    {open && <ul ref={list} role="menu" tabIndex={-1} aria-label={label} onKeyDown={onKeyDown}
      className="absolute right-0 z-30 mt-1 min-w-[13rem] origin-top-right animate-pop-in rounded border border-line bg-white py-1 text-sm shadow-pop focus:outline-none">
      {header && <li role="presentation" className="mb-1 border-b border-line px-3 pb-2 pt-1">{header}</li>}
      {items.map((item, index) => {
        const ItemIcon = item.icon;
        return <li key={item.label} role="menuitem" aria-disabled={item.disabled || undefined}
          onMouseEnter={() => setActive(index)} onClick={() => choose(index)}
          className={`flex items-center gap-2 px-3 py-1.5 ${item.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${item.danger ? 'text-red-700' : ''} ${index === active ? (item.danger ? 'bg-red-50' : 'bg-slate-100') : ''}`}>
          {ItemIcon && <ItemIcon className="h-4 w-4 shrink-0" aria-hidden />}{item.label}
        </li>;
      })}
    </ul>}
  </div>;
}

/** Filtro de opções mutuamente exclusivas, lado a lado (Todas / Ativas / Desativadas). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[]; label: string }) {
  return <div role="group" aria-label={label} className="inline-flex rounded border border-line bg-white p-0.5">
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}
      className={`h-7 rounded-sm px-2.5 text-xs transition-colors ${option.value === value ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:text-ink'}`}>{option.label}</button>)}
  </div>;
}

/** Caixa de marcação própria: `<input>` nativo (teclado, leitor de tela e formulários de graça)
 * com `appearance-none` para trocar o visual do sistema operacional pelo do design system. */
export function Checkbox({ checked, onChange, label, hint, name, disabled, className = '' }: {
  checked: boolean; onChange: (checked: boolean) => void; label?: ReactNode; hint?: ReactNode; name?: string; disabled?: boolean; className?: string;
}) {
  return <label className={`inline-flex items-start gap-2 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}>
    <span className="relative mt-0.5 grid h-4 w-4 shrink-0 place-items-center">
      <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}
        className="peer absolute inset-0 h-4 w-4 cursor-pointer appearance-none rounded-sm border border-line bg-white transition-colors checked:border-brand-600 checked:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 disabled:cursor-not-allowed" />
      <IconCheck aria-hidden className="pointer-events-none absolute h-3 w-3 text-white opacity-0 peer-checked:opacity-100" />
    </span>
    {label && <span className="min-w-0 flex-1 text-sm leading-4">{label}{hint && <span className="mt-0.5 block text-2xs font-normal text-slate-400">{hint}</span>}</span>}
  </label>;
}
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`block ${className}`}>
    <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-2xs text-slate-400">{hint}</span>}
  </label>;
}

export function PageHeader({ title, subtitle, action, back }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; back?: ReactNode }) {
  return <header className="flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0">
      {back}
      <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
    </div>
    {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
  </header>;
}

export function Stat({ label, value, hint, icon: IconCmp, tone = 'text-ink' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: Icon; tone?: string }) {
  return <div className="min-w-0">
    <p className="flex items-center gap-1.5 text-xs text-muted">{IconCmp && <IconCmp className="h-3.5 w-3.5" aria-hidden />}{label}</p>
    <p className={`tabular mt-1 text-2xl font-semibold tracking-tight ${tone}`}>{value}</p>
    {hint && <p className="mt-0.5 truncate text-2xs text-slate-400">{hint}</p>}
  </div>;
}

/** Lista vazia: ícone, frase e, se preciso, uma dica curta do que fazer (sem repetir botão que já existe na tela). */
export function EmptyState({ title, hint, action, icon: IconCmp = IconEmpty }: { title: string; hint?: ReactNode; action?: ReactNode; icon?: Icon }) {
  return <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
    <IconCmp className="h-6 w-6 text-slate-300" aria-hidden />
    <div className="space-y-1">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-xs text-xs text-muted">{hint}</p>}
    </div>
    {action}
  </div>;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-slate-100 ${className}`} />;
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'warning' | 'info' | 'brand'; children: ReactNode }) {
  const style = { danger: 'border-red-200 bg-red-50 text-red-800', warning: 'border-amber-200 bg-amber-50 text-amber-900', info: 'border-sky-200 bg-sky-50 text-sky-900', brand: 'border-brand-100 bg-brand-50 text-brand-800' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`animate-fade-in rounded border px-3 py-2 text-sm ${style}`}>{children}</div>;
}

/**
 * Área com rolagem própria e barra invisível. Por padrão só rola sozinha a partir do desktop
 * (lg), onde a tela tem colunas de altura fixa; no celular ela cresce com o conteúdo e quem rola
 * é a página inteira (lista rolando dentro de página rolando prendia o dedo no celular).
 * `always`: rola em qualquer tela (listas de altura limitada, ex.: grupos no formulário).
 */
export function ScrollArea({ children, className = '', always = false }: { children: ReactNode; className?: string; always?: boolean }) {
  return <div className={`scroll-area min-h-0 ${always ? 'overflow-y-auto' : 'lg:overflow-y-auto'} ${className}`}>{children}</div>;
}

/**
 * Página que ocupa exatamente a altura disponível; cada lista rola por dentro (Início,
 * Campanhas). Com `scroll`, a página cresce com o conteúdo e rola inteira — para telas com
 * várias seções empilhadas (Administração), onde espremer tudo numa tela corta conteúdo.
 */
export function Page({ children, className = '', scroll = false }: { children: ReactNode; className?: string; scroll?: boolean }) {
  // No celular a página sempre cresce com o conteúdo e rola inteira (travar na altura da tela
  // espremia colunas até sumirem); a altura fixa com listas rolando por dentro é só no desktop.
  // animate-fade-in roda uma vez, quando a tela monta (troca de rota) — os dados chegando por
  // trás (polling) não recriam o <main>, então a tela não fica piscando a cada atualização.
  return <main className={`mx-auto flex animate-fade-in ${scroll ? 'min-h-full' : 'min-h-full lg:h-full'} w-full max-w-6xl flex-col gap-4 px-4 py-5 md:px-6 ${className}`}>{children}</main>;
}
