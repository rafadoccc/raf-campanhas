import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em produção o próprio servidor (apps/server) entrega a pasta dist na mesma porta da
// API. Em desenvolvimento o Vite roda na 5173 e repassa /api para o servidor.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
