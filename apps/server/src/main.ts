import { prisma } from '@campaign/database';
import { buildApp } from './app';
import { bootstrapAdmin } from './auth';
import { loadConfig } from './config';
import { startDispatcher } from './dispatcher';
import { WhatsAppProvider } from './whatsapp';
import { WhatsAppManager, type ManagedProvider } from './whatsapp-manager';
import { createSendingRouter } from './sending-router';
import { legacySessionOwnerId } from './legacy-session';
import { legacyWhatsappSessionDir } from './session-paths';
import { migrateLegacySession } from './session-migration';

async function main() {
  const config = loadConfig(process.env);
  await bootstrapAdmin(process.env);
  // Fase 4E: a sessão global vira a sessão do dono (rename atômico, antes de qualquer conexão
  // abrir). Idempotente; com dono ambíguo ou qualquer falha, nada muda e a ponte continua.
  const migration = await migrateLegacySession();
  if (!['sem-sessao-legada', 'desligada'].includes(migration.outcome)) console.info('[WhatsApp] Migração da sessão global:', migration.outcome);
  const manager = new WhatsAppManager(); // conexões por usuário
  // Se a migração não aconteceu (dono ambíguo ou falha do sistema), a sessão global segue na
  // pasta antiga e a ponte cuida dela: o provider legado carrega o dono, isolando os eventos.
  const legacyOwnerId = await legacySessionOwnerId({
    legacyProvider: new WhatsAppProvider(),
    ownSessionDir: (userId: string) => manager.sessionDirFor(userId),
  });
  const provider = legacyOwnerId
    ? new WhatsAppProvider({ ownerId: legacyOwnerId, sessionDir: legacyWhatsappSessionDir(), legacySession: true })
    : new WhatsAppProvider();
  if (legacyOwnerId) console.info('[WhatsApp] Sessão global legada reconhecida como do usuário', legacyOwnerId, '(migração: fase 4E).');
  const app = buildApp(provider, config, manager);
  const dispatcher = await startDispatcher(createSendingRouter<ManagedProvider>({ manager, legacyProvider: provider }));
  let closing = false;

  async function shutdown() {
    if (closing) return;
    closing = true;
    await dispatcher.stop();
    await manager.stopAll(); // encerra preservando a autenticação de cada usuário
    await provider.stop();
    await app.close();
    await prisma.$disconnect();
  }

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  await app.listen({ port: config.port, host: config.host });
  // Num servidor que reinicia a cada deploy, esperar alguém clicar em Conectar pararia as
  // campanhas. Uma sessão já pareada é retomada sozinha; nunca gera QR sem pedido.
  if (process.env.WHATSAPP_AUTO_CONNECT !== '0' && await provider.hasPairedSession()) {
    console.log('Sessão do WhatsApp já pareada encontrada: reconectando.');
    void provider.connect();
  }
  // Reconecta as conexões por usuário já pareadas (nenhuma existe até alguém parear pelo painel).
  const reconnected = await manager.startAll();
  for (const item of reconnected.filter(r => r.outcome === 'falhou')) console.warn('[WhatsApp] Reconexão falhou para', item.userId, item.error);
  if (!config.webDist) console.warn('Painel não compilado (apps/web/dist ausente): só a API está disponível. Rode npm run build.');
  console.log(`Sistema pronto em ${config.publicUrl.origin} (escutando em ${config.host}:${config.port}). Conecte o WhatsApp pelo painel.`);
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
