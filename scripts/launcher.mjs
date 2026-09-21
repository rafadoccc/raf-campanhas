#!/usr/bin/env node
// Inicializador com pré-voo. Valida o ambiente, prepara o banco e o build, sobe
// o sistema (painel e API na mesma porta) e abre o navegador. É o que o .exe da área de trabalho
// executa. Também funciona direto: node scripts/launcher.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
// Um único processo serve painel e API na porta PORT do .env (padrão 3000).
const PORTA = Number(/^PORT=(\d+)\s*$/m.exec(existsSync('.env') ? readFileSync('.env', 'utf8') : '')?.[1] ?? 3000);
const PORTS = { sistema: PORTA };
const URL_PAINEL = `http://localhost:${PORTA}`;
// Fontes cujo conteudo decide se o build esta em dia (declarado no topo: o fluxo
// principal roda antes do fim do arquivo, e const nao sofre hoisting).
const FONTES = ['apps/server/src', 'apps/web/src', 'apps/web/index.html', 'apps/web/vite.config.mts', 'apps/web/tailwind.config.ts', 'packages/database/src', 'packages/database/prisma/schema.prisma'];

const ok = m => console.log(`  ✔  ${m}`);
const aviso = m => console.log(`  ⚠  ${m}`);
const passo = m => console.log(`\n  ▸ ${m}`);
function parar(titulo, dicas = []) {
  console.log(`\n  ✖  ${titulo}`);
  for (const d of dicas) console.log(`     ${d}`);
  console.log('');
  process.exit(1);
}

console.log('\n' + '═'.repeat(66));
console.log('  CENTRAL DE CAMPANHAS');
console.log('═'.repeat(66));

// 1 ─ Node ----------------------------------------------------------------
passo('Verificando o ambiente');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) parar(`Node.js ${process.versions.node} é antigo demais.`, ['Instale o Node.js 22 ou superior: https://nodejs.org']);
ok(`Node.js ${process.versions.node}`);

if (!existsSync('node_modules')) parar('Dependências não instaladas.', ['Rode uma vez: npm.cmd install']);
ok('Dependências instaladas');

// 2 ─ .env ----------------------------------------------------------------
if (!existsSync('.env')) parar('Arquivo .env não encontrado.', ['Copie .env.example para .env e coloque a senha do MySQL.']);
const env = readFileSync('.env', 'utf8');
const dbUrl = /^DATABASE_URL=(.+)$/m.exec(env)?.[1]?.trim();
if (!dbUrl) parar('DATABASE_URL ausente no .env.');
if (/<SENHA>|SUA_SENHA/.test(dbUrl)) {
  parar('A senha do MySQL ainda é um placeholder no .env.', [
    'Abra o arquivo .env na pasta do projeto e troque <SENHA> pela senha',
    'do seu usuário do MySQL (a mesma do MySQL Workbench).',
  ]);
}
ok('.env configurado');

// 3 ─ Porta do MySQL -------------------------------------------------------
const alvo = new URL(dbUrl);
if (alvo.protocol !== 'mysql:') parar('DATABASE_URL não é MySQL.', ['Formato esperado: mysql://root:SENHA@localhost:3306/campanhas']);
const dbPorta = Number(alvo.port || 3306);
if (!await portaAberta(alvo.hostname, dbPorta)) {
  parar(`MySQL não responde em ${alvo.hostname}:${dbPorta}.`, [
    'Abra o menu Iniciar > "Serviços" e inicie "MySQL80",',
    'ou no PowerShell (como administrador): Start-Service MySQL80',
  ]);
}
ok(`MySQL respondendo em ${alvo.hostname}:${dbPorta}`);

// 4 ─ Portas do sistema livres ----------------------------------------------
for (const [nome, porta] of Object.entries(PORTS)) {
  if (await portaAberta('127.0.0.1', porta)) {
    parar(`A porta ${porta} (${nome}) já está em uso.`, [
      'Talvez o sistema já esteja aberto em outra janela. Feche-a com Ctrl+C,',
      `ou encerre o programa que usa a porta: netstat -ano | findstr :${porta}`,
    ]);
  }
}
ok(`Porta ${PORTA} livre`);

// 5 ─ Banco: conexão, schema e migrations -----------------------------------
passo('Preparando o banco de dados');
rodar(process.execPath, ['--env-file=.env', 'scripts/check-db.mjs'], 'Diagnóstico do banco falhou.');
const migrar = spawnSync(process.execPath, ['--env-file=.env', 'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema=packages/database/prisma/schema.prisma'], { encoding: 'utf8' });
if (migrar.status !== 0) {
  const detalhe = (migrar.stderr || migrar.stdout || '').replaceAll(decodeURIComponent(alvo.password), '***').trim().split('\n').slice(-6).join('\n     ');
  parar('Não foi possível aplicar as migrations.', [detalhe]);
}
ok(/No pending migrations/.test(migrar.stdout) ? 'Banco atualizado (nada pendente)' : 'Migrations aplicadas');

// 6 ─ Build -----------------------------------------------------------------
passo('Conferindo o build');
if (precisaBuild()) {
  aviso('Código alterado ou build ausente. Compilando (pode levar 1 a 2 minutos)…');
  // npm run build já gera o client do Prisma.
  rodar(npm, ['run', 'build'], 'Falha na compilação.');
  mkdirSync('.runtime', { recursive: true });
  writeFileSync('.runtime/build-stamp', impressaoDigital());
  ok('Build concluído');
} else {
  ok('Build em dia');
}

// 7 ─ Primeiro acesso ------------------------------------------------------
// Sem nenhum usuário, o painel não deixa ninguém entrar: cria o primeiro aqui mesmo.
{
  const { PrismaClient } = createRequire(import.meta.url)('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const usuarios = await db.user.count().finally(() => db.$disconnect());
  if (usuarios) ok(`${usuarios} usuário(s) cadastrado(s)`);
  else if (/^ADMIN_EMAIL=\S/m.test(env)) ok('Primeiro usuário será criado a partir de ADMIN_EMAIL');
  else if (process.stdin.isTTY) {
    passo('Primeiro acesso: crie o usuário que vai entrar no painel');
    rodar(process.execPath, ['--env-file=.env', 'scripts/user-create.mjs'], 'Não foi possível criar o usuário.');
  } else aviso('Nenhum usuário cadastrado. Rode npm run user:create antes de entrar no painel.');
}

// 8 ─ Subir ----------------------------------------------------------------
passo('Iniciando os serviços');
const filho = spawn(process.execPath, ['scripts/start-local.cjs'], { stdio: 'inherit' });
let encerrando = false;
const encerrar = () => { if (encerrando) return; encerrando = true; filho.kill(); };
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
filho.on('exit', code => {
  console.log(`\n  Sistema encerrado${code ? ` (código ${code})` : ''}.`);
  process.exit(code ?? 0);
});

const pronto = await aguardar(async () => await portaAberta('127.0.0.1', PORTS.sistema), 90_000);
if (pronto) {
  console.log('\n' + '─'.repeat(66));
  console.log(`  ✔  Sistema no ar: ${URL_PAINEL}`);
  console.log('     Para encerrar, feche esta janela ou pressione Ctrl+C.');
  console.log('─'.repeat(66) + '\n');
  if (isWin) spawn('cmd', ['/c', 'start', '', URL_PAINEL], { detached: true, stdio: 'ignore' }).unref();
} else {
  aviso('Os serviços demoraram mais de 90 segundos. Confira os erros acima.');
}

// ─────────────────────────────────────────────────────────────────────────────
function rodar(cmd, args, falha) {
  // .cmd exige shell no Windows; os argumentos são fixos e vêm deste arquivo.
  const r = cmd.endsWith('.cmd')
    ? spawnSync([cmd, ...args].join(' '), { stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) parar(falha, ['Veja a mensagem acima.']);
}

function portaAberta(host, porta) {
  return new Promise(resolve => {
    const s = net.connect({ host, port: porta, timeout: 800 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

async function aguardar(cond, limiteMs) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// Recompila se algum build falta ou se o CONTEÚDO dos fontes mudou desde o último
// build. Não usa data de modificação: arquivos sincronizados pelo OneDrive ou
// gravados por outra ferramenta podem ter datas no futuro e forçariam um rebuild
// a cada execução.
function precisaBuild() {
  const saidas = ['apps/server/dist/main.js', 'packages/database/dist/client.js', 'apps/web/dist/index.html'];
  if (saidas.some(f => !existsSync(f))) return true;
  const anterior = existsSync('.runtime/build-stamp') ? readFileSync('.runtime/build-stamp', 'utf8').trim() : '';
  return anterior !== impressaoDigital();
}
function impressaoDigital() {
  const h = createHash('sha1');
  for (const arquivo of FONTES.flatMap(listar).sort()) {
    // Normaliza fim de linha: CRLF vs LF não é mudança de código.
    h.update(arquivo).update(readFileSync(arquivo, 'utf8').split(String.fromCharCode(13)).join(''));
  }
  return h.digest('hex');
}
function listar(caminho) {
  if (!existsSync(caminho)) return [];
  if (!statSync(caminho).isDirectory()) return [caminho];
  return readdirSync(caminho).flatMap(n => listar(path.join(caminho, n)));
}
