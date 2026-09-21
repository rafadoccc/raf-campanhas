// Endereço único da API. NEXT_PUBLIC_* é gravada no bundle durante o build; o
// next.config.js carrega o .env da raiz para que o valor configurado chegue aqui.
// O padrão já inclui o prefixo /api que o servidor usa em todas as rotas.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api').replace(/\/+$/, '');
