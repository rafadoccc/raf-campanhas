import type { CSSProperties } from 'react';

// Rabiscos da página de apresentação (/conheca). São traços simples; o ar de "feito à mão" vem do
// filtro #rabisco (DoodleDefs), que entorta de leve qualquer linha. Tudo em SVG no próprio código:
// nada é baixado de fora (a política de segurança do painel só aceita arquivos do próprio site).

const PATHS = {
  megafone: ['M18 42 L18 58 L32 58 L62 76 L62 24 L32 42 Z', 'M30 58 L34 78 L44 78 L40 62', 'M72 38 Q80 50 72 62', 'M80 30 Q94 50 80 70'],
  celular: ['M34 10 h32 a6 6 0 0 1 6 6 v68 a6 6 0 0 1 -6 6 h-32 a6 6 0 0 1 -6 -6 v-68 a6 6 0 0 1 6 -6 z', 'M38 30 h18 v10 h-12 l-6 5 z', 'M62 52 h-18 v10 h12 l6 5 z', 'M46 80 h8'],
  sorriso: ['M50 12 a38 38 0 1 0 0.1 0', 'M36 40 v8', 'M62 38 v10', 'M30 58 Q50 82 72 56', 'M40 66 v8 M50 69 v8 M60 66 v7'],
  estrela: ['M50 10 L60 38 L90 40 L66 58 L75 88 L50 70 L25 88 L34 58 L10 40 L40 38 Z'],
  raio: ['M56 8 L28 54 L48 54 L40 92 L74 42 L52 42 Z'],
  lua: ['M62 14 A36 36 0 1 0 86 62 A28 28 0 1 1 62 14 Z', 'M18 18 h12 l-12 12 h12', 'M8 40 h8 l-8 8 h8'],
  globo: ['M50 26 a30 30 0 1 0 0.1 0', 'M50 6 v20', 'M22 48 Q50 60 78 48 M24 68 Q50 78 76 68', 'M40 28 Q30 56 42 85 M60 28 Q70 56 58 85'],
  seta: ['M10 60 Q30 20 50 55 T88 40', 'M76 34 L90 40 L80 52'],
  grafico: ['M14 84 h74', 'M24 84 v-22 M42 84 v-40 M60 84 v-30 M78 84 v-56'],
  coracao: ['M50 84 C10 56 18 22 40 24 C48 25 50 34 50 34 C50 34 54 24 62 24 C84 22 88 58 50 84 Z'],
} as const;

export type DoodleName = keyof typeof PATHS;

/** Uma vez por página: o filtro que dá o tremido de caneta aos rabiscos. */
export function DoodleDefs() {
  return <svg aria-hidden width="0" height="0" className="absolute">
    <filter id="rabisco" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="ruido" />
      <feDisplacementMap in="SourceGraphic" in2="ruido" scale="5" />
    </filter>
  </svg>;
}

/** Um rabisco. A cor vem do texto (currentColor); o tamanho, de `className`. */
export function Doodle({ name, className = '', style }: { name: DoodleName; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" filter="url(#rabisco)" className={className} style={style}>
    {PATHS[name].map(d => <path key={d} d={d} />)}
  </svg>;
}
