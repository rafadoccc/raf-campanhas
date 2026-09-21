#!/usr/bin/env node
// Cria um usuário do painel ou redefine a senha de um existente.
// Uso: npm run user:create   (pergunta e-mail, nome e senha; a senha não aparece na tela)
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prisma } = require('@campaign/database');
const { hashPassword, validateNewPassword, normalizeEmail } = require('../apps/server/dist/auth.js');

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = question => new Promise(resolve => rl.question(question, resolve));
// Pergunta sem ecoar o que é digitado.
function askHidden(question) {
  return new Promise(resolve => {
    const write = rl._writeToOutput;
    rl._writeToOutput = text => { if (text.includes(question)) write.call(rl, text); };
    rl.question(question, answer => { rl._writeToOutput = write; process.stdout.write('\n'); resolve(answer); });
  });
}

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
