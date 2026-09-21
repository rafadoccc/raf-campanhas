import { prisma } from '@campaign/database';
import { buildApp } from './app';
import { bootstrapAdmin } from './auth';
import { loadConfig } from './config';
import { startDispatcher } from './dispatcher';
import { WhatsAppProvider } from './whatsapp';

async function main() {
  const config = loadConfig(process.env);
  await bootstrapAdmin(process.env);
  const provider = new WhatsAppProvider();
  const app = buildApp(provider, config);
  const dispatcher = await startDispatcher(provider);
  let closing = false;

  async function shutdown() {
    if (closing) return;
    closing = true;
    await dispatcher.stop();
    await provider.stop();
    await app.close();
    await prisma.$disconnect();
  }

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  await app.listen({ port: config.port, host: config.host });
  if (!config.webDist) console.warn('Painel não compilado (apps/web/dist ausente): só a API está disponível. Rode npm run build.');
  console.log(`Sistema pronto em ${config.publicUrl.origin} (escutando em ${config.host}:${config.port}). Conecte o WhatsApp pelo painel.`);
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
