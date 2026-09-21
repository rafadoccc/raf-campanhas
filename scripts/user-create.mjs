#!/usr/bin/env node
// Cria um usuário do painel ou redefine a senha de um existente.
// Uso: npm run user:create   (pergunta e-mail, nome e senha; a senha não aparece na tela)
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma } = require('@campaign/database');
const { hashPassword, validateNewPassword, normalizeEmail } = require('../apps/server/dist/auth.js');

// Lê linha a linha por um iterador: funciona digitando no console (inclusive no .exe) e
// com as respostas enviadas de uma vez por outro programa.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
let muted = false;
const echo = rl._writeToOutput?.bind(rl);
if (echo) rl._writeToOutput = text => { if (!muted) echo(text); };

async function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden; // no console, o que é digitado na senha não aparece na tela
  const { value, done } = await lines.next();
  muted = false;
  if (hidden && process.stdin.isTTY) process.stdout.write('\n');
  if (done) throw new Error('Entrada encerrada antes de terminar.');
  return value;
}
const askHidden = question => ask(question, true);

try {
  const email = normalizeEmail(await ask('E-mail: '));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  const existing = await prisma.user.findUnique({ where: { email } });
  const name = existing ? existing.name : ((await ask('Nome: ')).trim() || 'Administrador');
  const password = await askHidden(existing ? 'Nova senha: ' : 'Senha: ');
  const problem = validateNewPassword(password);
  if (problem) throw new Error(problem);
  if (password !== await askHidden('Repita a senha: ')) throw new Error('As senhas não conferem.');
  const passwordHash = await hashPassword(password);
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, disabledAt: null } });
    await prisma.authSession.deleteMany({ where: { userId: existing.id } });
    console.log(`Senha de ${email} redefinida. Sessões antigas encerradas.`);
  } else {
    await prisma.user.create({ data: { email, name, passwordHash, role: 'OWNER' } });
    console.log(`Usuário ${email} criado.`);
  }
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await prisma.$disconnect();
}
