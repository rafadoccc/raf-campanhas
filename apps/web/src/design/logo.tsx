// A "logo" do DocDrop é só o nome escrito (sem símbolo à parte). A ideia do sistema está na
// palavra: o "Doc" é o que você prepara, o "Drop" é a entrega no grupo. Três modelos, para o dono
// escolher; LOGO_VARIANT define o que o sistema usa em todo lugar (menu, entrada, páginas avulsas).
//
//   queda  "Doc" firme + um ponto verde que CAIU abaixo da linha + "Drop" leve em verde.
//   gota   tudo minúsculo, e o "o" de drop é uma gota verde.
//   peso   "Doc" em negrito escuro, "Drop" fino em verde: só o contraste de peso e cor.

export type LogoVariant = 'queda' | 'gota' | 'peso';
export const LOGO_VARIANT: LogoVariant = 'queda';

/** Tamanho vem da fonte do lugar onde a logo entra (text-sm no menu, text-xl na entrada…). */
export function Logo({ variant = LOGO_VARIANT, className = '' }: { variant?: LogoVariant; className?: string }) {
  const base = `inline-flex select-none items-baseline whitespace-nowrap leading-none tracking-tight ${className}`;
  if (variant === 'gota') {
    return <span className={`${base} font-semibold lowercase text-ink`} role="img" aria-label="DocDrop">
      <span aria-hidden>docdr</span>
      {/* A gota ocupa o lugar do "o": mesma altura das letras baixas, ponta para cima. */}
      <svg aria-hidden viewBox="0 0 20 24" className="mx-[0.03em] h-[0.74em] w-[0.6em] translate-y-[0.03em] text-brand-500"><path fill="currentColor" d="M10 1c3.8 4.9 8 9.2 8 13.6A8 8 0 0 1 2 14.6C2 10.2 6.2 5.9 10 1Z" /></svg>
      <span aria-hidden>p</span>
    </span>;
  }
  if (variant === 'peso') {
    return <span className={base} role="img" aria-label="DocDrop">
      <span aria-hidden className="font-bold text-ink">Doc</span><span aria-hidden className="font-normal text-brand-600">Drop</span>
    </span>;
  }
  return <span className={base} role="img" aria-label="DocDrop">
    <span aria-hidden className="font-semibold text-ink">Doc</span>
    {/* O ponto que caiu: fica abaixo da linha do texto, como algo que acabou de ser solto. */}
    <span aria-hidden className="ml-[0.07em] mr-[0.11em] inline-block h-[0.24em] w-[0.24em] translate-y-[0.2em] rounded-full bg-brand-500" />
    <span aria-hidden className="font-normal text-brand-700">Drop</span>
  </span>;
}
