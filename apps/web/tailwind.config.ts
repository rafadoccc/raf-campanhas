import type { Config } from 'tailwindcss';

// Tokens do design system (docs/design-system.md). Cantos sempre quadrados (5–6 px): nada de
// pílulas nem cartões muito arredondados. `rounded-full` fica só para pontos de status.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Marca: verde WhatsApp, um pouco mais sóbrio.
        brand: { 50: '#ecfdf3', 100: '#d1fadf', 500: '#16a34a', 600: '#15803d', 700: '#166534', 800: '#14532d' },
        canvas: '#f5f6f8',
        line: '#e3e6ea',
        ink: '#161b22',
        muted: '#5b6573',
      },
      fontFamily: {
        // Fonte do sistema: carrega na hora e não depende de CDN (a CSP só permite 'self').
        hand: ['"Segoe Print"', '"Bradley Hand"', '"Chalkboard SE"', '"Comic Neue"', '"Comic Sans MS"', 'cursive'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      fontSize: { '2xs': ['0.6875rem', { lineHeight: '1rem' }] },
      boxShadow: { card: '0 1px 2px rgba(16, 24, 40, 0.05)', pop: '0 8px 24px rgba(16, 24, 40, 0.12)' },
      // Animações curtas e discretas (150–200 ms): dão sensação de fluidez sem chamar atenção
      // para si. Usadas ao trocar de tela, em avisos, em listas suspensas (Select/Menu), no
      // diálogo de confirmação e em blocos que se revelam (ex.: "Modelo da mensagem"). Respeitam
      // "reduzir movimento" do sistema operacional (ver styles.css).
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'pop-in': { from: { opacity: '0', transform: 'scale(0.96) translateY(-2px)' }, to: { opacity: '1', transform: 'scale(1) translateY(0)' } },
        'overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        // Troca de página (notas de atualização): o conteúdo entra do lado para onde se avançou.
        'slide-from-right': { from: { opacity: '0', transform: 'translateX(14px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-from-left': { from: { opacity: '0', transform: 'translateX(-14px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        // Página de apresentação: rabisco balançando, flutuando ao fundo e a faixa correndo.
        'doodle-wiggle': { '0%, 100%': { transform: 'rotate(0deg)' }, '25%': { transform: 'rotate(-7deg)' }, '75%': { transform: 'rotate(7deg)' } },
        'doodle-float': { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-10px)' } },
        'doodle-marquee': { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out backwards',
        'pop-in': 'pop-in 150ms ease-out backwards',
        'overlay-in': 'overlay-in 150ms ease-out backwards',
        'slide-from-right': 'slide-from-right 240ms cubic-bezier(0.22, 1, 0.36, 1) backwards',
        'slide-from-left': 'slide-from-left 240ms cubic-bezier(0.22, 1, 0.36, 1) backwards',
        'doodle-wiggle': 'doodle-wiggle 500ms ease-in-out',
        'doodle-float': 'doodle-float 7s ease-in-out infinite',
        'doodle-marquee': 'doodle-marquee 28s linear infinite',
      },
    },
    borderRadius: {
      none: '0', sm: '3px', DEFAULT: '5px', md: '5px', lg: '6px', xl: '6px', '2xl': '6px', full: '9999px',
    },
  },
  plugins: [],
};
export default config;
