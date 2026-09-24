#!/usr/bin/env node
// Copia o login dos administradores da produção para o banco da dev: mesmo e-mail e mesma
// senha (só o hash; a senha nunca aparece). Assim quem entra na produção entra na dev igual.
// Uso (na pasta da dev): npm run dev:sincronizar-login
//
// Segurança: só ESCREVE num banco cujo nome termina em "_dev" e só LÊ da produção. Nunca
// altera a produção. A conta de administrador de teste da dev (e-mail @dev.local) vira a sua,
// mantendo as campanhas e grupos de teste que já eram dela.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const devUrl = process.env.DATABASE_URL ?? '';
const devName = new URL(devUrl).pathname.slice(1);
if (!devName.endsWith('_dev')) {
  console.error(`Recusado: o banco deste .env ("${devName}") não é de desenvolvimento (precisa terminar em _dev).`);
  process.exit(1);
}
const prodUrl = process.env.PROD_DATABASE_URL ?? devUrl.replace(`/${devName}`, `/${devName.slice(0, -4)}`);
const prod = new PrismaClient({ datasources: { db: { url: prodUrl } } });
const dev = new PrismaClient({ datasources: { db: { url: devUrl } } });

try {
  const admins = await prod.user.findMany({ where: { role: 'SUPER_ADMIN', disabledAt: null }, select: { email: true, name: true, passwordHash: true } });
  if (!admins.length) throw new Error('Nenhum administrador ativo na produção.');
  for (const admin of admins) {
    const same = await dev.user.findUnique({ where: { email: admin.email } });
    if (same) {
      await dev.user.update({ where: { id: same.id }, data: { passwordHash: admin.passwordHash, role: 'SUPER_ADMIN', disabledAt: null } });
      console.log(`✔ ${admin.email}: senha igual à da produção.`);
      continue;
    }
    // Assume a conta de administrador de teste (mantém os dados de teste dela).
    const testAdmin = await dev.user.findFirst({ where: { role: 'SUPER_ADMIN', email: { endsWith: '@dev.local' } }, orderBy: { createdAt: 'asc' } });
    if (testAdmin) {
      await dev.user.update({ where: { id: testAdmin.id }, data: { email: admin.email, name: admin.name, passwordHash: admin.passwordHash, disabledAt: null } });
      console.log(`✔ ${admin.email}: assumiu a conta de teste ${testAdmin.email} (mesma senha da produção).`);
    } else {
      await dev.user.create({ data: { email: admin.email, name: admin.name, passwordHash: admin.passwordHash, role: 'SUPER_ADMIN' } });
      console.log(`✔ ${admin.email}: criada na dev com a mesma senha da produção.`);
    }
  }
  console.log('Pronto. Se errou a senha várias vezes antes, reinicie o sistema da dev (o limite de tentativas zera).');
} catch (error) {
  console.error('Falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prod.$disconnect();
  await dev.$disconnect();
}
