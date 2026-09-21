import { prisma } from '@campaign/database';
import { buildApp } from './app';
import { startDispatcher } from './dispatcher';
import { WhatsAppProvider } from './whatsapp';

async function main() {
  const provider = new WhatsAppProvider();
  const app = buildApp(provider);
  const dispatcher = await startDispatcher(provider);
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
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
  await app.listen({ port, host });
  console.log(`Servidor pronto em http://${host}:${port}. Conecte o WhatsApp pelo painel; nenhuma sessão é iniciada automaticamente.`);
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
