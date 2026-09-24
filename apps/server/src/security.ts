import type { FastifyError, FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { AppConfig } from './config';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// O painel é uma aplicação React sem scripts inline. 'unsafe-inline' em estilos cobre só
// atributos style; data:/blob: servem ao QR Code e à pré-visualização de mídia local.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "font-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');

export function registerSecurity(app: FastifyInstance, config: AppConfig) {
  app.addHook('onRequest', async (request, reply) => {
    // Host desconhecido: DNS rebinding ou acesso por um endereço não configurado.
    if (config.allowedHosts && !config.allowedHosts.includes(request.hostname)) return reply.code(403).send({ error: 'Endereço não permitido. Confira PUBLIC_URL.' });
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) return reply.code(403).send({ error: 'Origem não permitida.' });
    // Ações que alteram dados precisam vir do próprio painel. Navegadores sempre enviam
    // Origin nelas; sem Origin é um cliente fora do painel (ou um formulário forjado).
    if (UNSAFE_METHODS.has(request.method) && request.url.startsWith('/api/') && !origin) {
      return reply.code(403).send({ error: 'Requisição sem origem. Use o painel.' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    // API sem cache, exceto quando a rota define o próprio (mídia imutável: cache privado).
    if (request.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Erros inesperados não expõem detalhes internos (banco, caminhos). As mensagens de
  // negócio continuam saindo, porque as rotas as enviam explicitamente com 400.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'Arquivo acima do limite permitido.' });
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'Tipo de arquivo não suportado.' });
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: 'Requisição inválida.' });
    request.log.error({ err: error, requestId: request.id }, 'erro inesperado');
    return reply.code(500).send({ error: 'Erro interno. Tente de novo; se persistir, veja o log do servidor.', requestId: request.id });
  });
}

// Painel compilado (apps/web/dist) na mesma porta da API. Qualquer rota que não seja da
// API devolve o index.html, e o React Router decide a tela.
export function registerWeb(app: FastifyInstance, config: AppConfig) {
  if (config.webDist) {
    void app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      index: false,
      setHeaders(reply, filePath) {
        // Arquivos em assets/ têm hash no nome: podem ficar em cache para sempre.
        reply.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.method !== 'GET') return reply.code(404).send({ error: 'Rota não encontrada.' });
    if (!config.webDist) return reply.code(503).send({ error: 'Painel não compilado. Rode npm run build.' });
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  });
}

// Recurso inexistente OU de outro usuário (ADR-018): as rotas respondem 404 com a mesma mensagem
// nos dois casos, para não revelar que o recurso existe.
export class NotFoundError extends Error {}

// Erros de domínio (lançados por nós com texto para o usuário) podem ir para a tela; os
// do Prisma ou do sistema não, porque carregam detalhes internos.
export function publicMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  if (error.constructor.name.startsWith('PrismaClient') || /prisma|invocation|ECONN|SQL/i.test(error.message)) return fallback;
  // Erro do sistema operacional (arquivo, rede, permissão): traz caminhos e detalhes da máquina.
  if ('syscall' in error || 'errno' in error || /\bE[A-Z]{2,}:|[A-Za-z]:\\|\/(?:home|usr|var|tmp|etc|root|app|data|opt)\/|node_modules/.test(error.message)) return fallback;
  return error.message;
}
