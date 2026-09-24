// Banco MySQL descartável. Nunca migra nem apaga o banco configurado no .env.
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

async function main() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL ausente. Execute com --env-file=.env.');
  const database = `campaign_test_${randomBytes(8).toString('hex')}`;
  // Identificadores não podem ser parametrizados: o nome é gerado aqui e validado antes do uso.
  if (!/^campaign_test_[a-f0-9]{16}$/.test(database)) throw Error('Banco de teste inválido.');

  const url = new URL(process.env.DATABASE_URL);
  if (url.protocol !== 'mysql:') throw Error('DATABASE_URL precisa ser mysql://');
  url.pathname = `/${database}`;
  const env = { ...process.env, DATABASE_URL: url.toString(), CAMPAIGN_TEST_DATABASE: database };
  const redact = text => String(text).replaceAll(process.env.DATABASE_URL, '[DATABASE_URL]').replaceAll(url.toString(), '[DATABASE_URL]');

  const db = new PrismaClient();
  try {
    await db.$executeRawUnsafe(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema=packages/database/prisma/schema.prisma'], { env, encoding: 'utf8' });
    if (migration.status !== 0) throw Error('Migração isolada falhou. ' + redact(migration.stderr || migration.stdout));
    // TEST_NAME_PATTERN="parallel" roda só os testes cujo nome casa (útil para investigar).
    const filter = process.env.TEST_NAME_PATTERN ? [`--test-name-pattern=${process.env.TEST_NAME_PATTERN}`] : [];
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...filter, 'apps/server/dist/integration.test.js'], { env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } finally {
    // Somente o banco aleatório criado acima entra aqui.
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${database}\``);
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
