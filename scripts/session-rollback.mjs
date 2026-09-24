#!/usr/bin/env node
// Desfaz a migração da sessão global (Fase 4E): devolve users/<dono>/whatsapp para
// SESSIONS_DIR/whatsapp. Use só com o sistema FECHADO.
// Uso: npm run whatsapp:reverter-migracao
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { prisma } = require('@campaign/database');
const { rollbackLegacySession, migrationRecordPath } = require('../apps/server/dist/session-migration.js');
const { usersSessionsRoot } = require('../apps/server/dist/session-paths.js');

try {
  const root = usersSessionsRoot();
  const migrated = existsSync(root) ? readdirSync(root).filter(id => existsSync(migrationRecordPath(id))) : [];
  if (migrated.length !== 1) {
    console.log(migrated.length ? `Mais de uma migração registrada (${migrated.join(', ')}). Reverta manualmente.` : 'Nenhuma migração registrada. Nada a reverter.');
    process.exitCode = migrated.length ? 1 : 0;
  } else {
    const result = await rollbackLegacySession(migrated[0]);
    console.log(result.outcome === 'revertida'
      ? `Sessão devolvida para ${path.join(path.dirname(root), 'whatsapp')}. Abra o sistema normalmente.`
      : `Nada foi movido: ${result.detail ?? result.outcome}.`);
    if (result.outcome === 'conflito') process.exitCode = 1;
  }
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
