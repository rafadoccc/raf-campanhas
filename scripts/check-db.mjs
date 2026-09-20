#!/usr/bin/env node
// Diagnóstico da conexão com o PostgreSQL local. Não imprime a senha.
// Uso: npm run db:check
import { PrismaClient } from '@prisma/client';

const linha = '─'.repeat(66);
const url = process.env.DATABASE_URL;

console.log(`\n${linha}\n  DIAGNÓSTICO DO BANCO\n${linha}`);

if (!url) {
  console.log('  ✖  DATABASE_URL ausente. Rode com: npm run db:check');
  process.exit(1);
}
if (url.includes('<SENHA>') || url.includes('SUA_SENHA')) {
  console.log('  ✖  A senha ainda é um placeholder no .env.');
  console.log('     Edite o .env e troque <SENHA> pela senha do seu usuário postgres.');
  process.exit(1);
}

let alvo;
try {
  alvo = new URL(url);
} catch {
  console.log('  ✖  DATABASE_URL não é uma URL válida.');
  process.exit(1);
}
const schema = alvo.searchParams.get('schema') ?? 'public';
console.log(`  Servidor: ${alvo.hostname}:${alvo.port || 5432}`);
console.log(`  Banco:    ${alvo.pathname.slice(1)}`);
console.log(`  Schema:   ${schema}`);
console.log(`  Usuário:  ${alvo.username}\n`);

const prisma = new PrismaClient();
try {
  const [{ version }] = await prisma.$queryRaw`SELECT version()`;
  console.log(`  ✔  Conectado. ${version.split(',')[0]}`);

  const existe = await prisma.$queryRaw`
    SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}`;
  if (!existe.length) {
    console.log(`  ⚠  O schema "${schema}" ainda não existe. Criando…`);
    // Identificadores não podem ser parametrizados; o nome vem do próprio .env
    // do operador e é validado antes de qualquer interpolação.
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error(`Nome de schema inválido: ${schema}`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    console.log(`  ✔  Schema "${schema}" criado.`);
  } else {
    console.log(`  ✔  Schema "${schema}" existe.`);
  }

  const tabelas = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = ${schema} ORDER BY table_name`;
  const nomes = tabelas.map(t => t.table_name);
  const aplicadas = nomes.includes('_prisma_migrations');

  if (!aplicadas) {
    console.log(`  ⚠  Migrations ainda não aplicadas. Rode: npm run db:deploy`);
  } else {
    const pendentes = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
       WHERE finished_at IS NULL ORDER BY started_at`;
    console.log(`  ✔  ${nomes.length - 1} tabelas no schema.`);
    if (pendentes.length) console.log(`  ⚠  ${pendentes.length} migration(s) incompleta(s).`);
    else console.log('  ✔  Todas as migrations concluíram.');
  }
  console.log(`${linha}\n`);
} catch (error) {
  const limpo = String(error.message).replaceAll(alvo.password, '***').split('\n').slice(0, 4).join('\n     ');
  console.log(`  ✖  Falha ao conectar.\n     ${limpo}`);
  console.log(`\n  Verifique: o serviço postgresql-x64-18 está rodando? A senha está correta?`);
  console.log(`  O banco "${alvo.pathname.slice(1)}" existe?\n${linha}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
