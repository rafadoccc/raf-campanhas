// Ponto de entrada do sistema. É o "arquivo de entrada" configurado na Hostinger e o que o
// inicializador local executa. Aplica as migrations pendentes e sobe o servidor, que
// entrega o painel e a API na mesma porta.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Localmente o .env fica na raiz; na Hostinger as variáveis vêm do painel (hPanel).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* sem .env: usa o ambiente */ }

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida. Configure a conexão com o MySQL (veja .env.example).');
  process.exit(1);
}

// Nunca sobe com o banco desatualizado: uma migration pendente mudaria o que o código espera.
const migrate = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema=packages/database/prisma/schema.prisma'], { cwd: __dirname, stdio: 'inherit', env: process.env });
if (migrate.status !== 0) {
  console.error('Não foi possível aplicar as migrations do banco. O servidor não vai subir. Veja o erro acima.');
  process.exit(1);
}

require('./apps/server/dist/main.js');
