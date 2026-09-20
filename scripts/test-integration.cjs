// Disposable PostgreSQL schema. Never reset or migrate the user's production schema.
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
async function main() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL ausente. Execute com --env-file=.env.');
  const schema = `campaign_test_${randomBytes(8).toString('hex')}`;
  if (!/^campaign_test_[a-f0-9]{16}$/.test(schema)) throw Error('Schema de teste inválido.');
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set('schema', schema);
  const env = { ...process.env, DATABASE_URL: url.toString(), CAMPAIGN_TEST_SCHEMA: schema };
  const db = new PrismaClient();
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema=packages/database/prisma/schema.prisma'], { env, encoding: 'utf8' });
    if (migration.status !== 0) throw Error('Migração isolada falhou. ' + migration.stderr.replaceAll(process.env.DATABASE_URL, '[DATABASE_URL]'));
    const result = spawnSync(process.execPath, ['--test', 'apps/api/dist/integration.test.js'], { env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } finally {
    // Exact random schema created above; no public/user schema can enter this branch.
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
