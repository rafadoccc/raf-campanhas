const path = require('node:path');

// O Next só lê arquivos .env dentro de apps/web, mas a configuração do projeto fica na
// raiz. Sem isto, NEXT_PUBLIC_API_URL não chegava ao build e o painel chamava a API sem
// o prefixo /api (404 ao gerar o QR). loadEnvFile não sobrescreve variáveis já definidas.
try {
  process.loadEnvFile(path.join(__dirname, '../../.env'));
} catch {
  // Sem .env (ex.: CI): vale o padrão de components/api-url.ts.
}

module.exports = { outputFileTracingRoot: path.join(__dirname, '../..') };
