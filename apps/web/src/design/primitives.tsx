import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { IconEmpty, IconLoading } from './icons';

// Peças básicas do design system (docs/design-system.md). Cantos de 5–6 px, borda fina,
// sombra quase nula. Uma ação principal por área; o resto é secundário ou discreto.

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const base = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';
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
  return <span title={title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide ${tones[tone]} ${className}`}>{children}</span>;
}

/** Ponto de status (o único elemento redondo do sistema). */
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'busy' | 'off' }) {
  const color = { ok: 'bg-brand-500', warn: 'bg-amber-500', busy: 'bg-sky-500', off: 'bg-slate-300' }[tone];
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

export const inputClass = 'block w-full rounded border border-line bg-white px-2.5 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
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

export function EmptyState({ title, action, icon: IconCmp = IconEmpty }: { title: string; action?: ReactNode; icon?: Icon }) {
  return <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
    <IconCmp className="h-6 w-6 text-slate-300" aria-hidden />
    <p className="text-sm text-muted">{title}</p>
    {action}
  </div>;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-slate-100 ${className}`} />;
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'warning' | 'info' | 'brand'; children: ReactNode }) {
  const style = { danger: 'border-red-200 bg-red-50 text-red-800', warning: 'border-amber-200 bg-amber-50 text-amber-900', info: 'border-sky-200 bg-sky-50 text-sky-900', brand: 'border-brand-100 bg-brand-50 text-brand-800' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded border px-3 py-2 text-sm ${style}`}>{children}</div>;
}

/** Área com rolagem própria e barra invisível. Use dentro de um contêiner com altura definida. */
export function ScrollArea({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`scroll-area min-h-0 ${className}`}>{children}</div>;
}

/** Página que ocupa exatamente a altura disponível (sem rolagem do documento). */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <main className={`mx-auto flex h-full w-full max-w-6xl flex-col gap-4 px-4 py-5 md:px-6 ${className}`}>{children}</main>;
}
