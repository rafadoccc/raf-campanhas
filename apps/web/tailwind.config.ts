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
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      fontSize: { '2xs': ['0.6875rem', { lineHeight: '1rem' }] },
      boxShadow: { card: '0 1px 2px rgba(16, 24, 40, 0.05)', pop: '0 8px 24px rgba(16, 24, 40, 0.12)' },
    },
    borderRadius: {
      none: '0', sm: '3px', DEFAULT: '5px', md: '5px', lg: '6px', xl: '6px', '2xl': '6px', full: '9999px',
    },
  },
  plugins: [],
};
export default config;
