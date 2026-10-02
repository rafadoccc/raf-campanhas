import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@campaign/database';
import type { Prisma } from '@prisma/client';
import type { AppConfig } from './config';
import { apiPath } from './api-path';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const SESSION_COOKIE = 'campanhas_sessao';
// Rotas da API acessíveis sem login. Todo o resto exige sessão (negar por padrão).
// /api/legal: contato e versão dos Termos, que as páginas públicas de Privacidade e Termos mostram.
// /api/public/report/:token: relatório da campanha pelo código do link (ADR-045); é o padrão da
// ROTA casada pelo Fastify (api-path.ts), então nenhum outro endereço cai aqui.
// /api/auth/forgot e /api/auth/reset/:token: "esqueci minha senha" (ADR-047), por definição sem login.
const PUBLIC_API = new Set(['/api/health', '/api/auth/login', '/api/auth/setup', '/api/legal', '/api/public/report/:token', '/api/auth/forgot', '/api/auth/reset/:token']);

// Papéis (ADR-016). O papel vem SEMPRE do banco, pela sessão validada no servidor; nada que o
// navegador envie (corpo, cabeçalho, cookie próprio) decide permissão.
export type Role = 'SUPER_ADMIN' | 'USER';
/** termsPending: ainda não aceitou a versão atual dos Termos e da Política (ADR-040). */
export type SessionUser = { id: string; email: string; name: string; role: Role; termsPending: boolean };

// Versão vigente dos Termos de Uso e da Política de Privacidade (ADR-040). Mudou o texto de
// forma relevante? Troque a data: todo mundo aceita de novo no próximo acesso.
export const TERMS_VERSION = '2026-09-30';
const publicSessionUser = (user: { id: string; email: string; name: string; role: Role; termsVersion: string | null }): SessionUser =>
  ({ id: user.id, email: user.email, name: user.name, role: user.role, termsPending: user.termsVersion !== TERMS_VERSION });
declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null }
}

// ─── Senhas ──────────────────────────────────────────────────────────────────────
// scrypt N=2^15, r=8, p=1: ~32 MB e ~0,1 s por verificação. Custo alto o bastante para
// atrasar força bruta, baixo o bastante para hospedagem compartilhada.
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD = 10;

/** Servidor no limite de trabalho simultâneo: o pedido é recusado em vez de enfileirado sem fim. */
export class ServerBusyError extends Error {
  constructor() { super('Servidor ocupado. Tente de novo em alguns segundos.'); }
}

/**
 * Limita quantas tarefas pesadas rodam ao mesmo tempo. Até `max` rodando e `queue` esperando;
 * além disso recusa na hora (ServerBusyError).
 */
export class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private max: number, private queue: number) {}
  get load() { return { running: this.running, waiting: this.waiting.length }; }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.max) this.running++;
    else if (this.waiting.length >= this.queue) throw new ServerBusyError();
    else await new Promise<void>(resolve => this.waiting.push(resolve)); // a vaga vem de quem terminou
    try { return await task(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // passa a vaga adiante sem liberar
      else this.running--;
    }
  }
}

// Cada scrypt ocupa ~32 MB. Sem limite, uma rajada de logins (de muitos IPs, que o limite por IP
// não segura) esgotaria a memória de uma VPS pequena. Dois ao mesmo tempo, até 32 na fila.
export const passwordGate = new Gate(2, 32);

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await passwordGate.run(() => scrypt(password, salt, 64, KDF));
  return `scrypt$${KDF.N}$${KDF.r}$${KDF.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await passwordGate.run(() => scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: KDF.maxmem }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Usado quando o e-mail não existe: gasta o mesmo tempo de uma verificação real, para o
// tempo de resposta não revelar quais e-mails estão cadastrados.
let dummyHash: Promise<string> | undefined;
const burnTime = async (password: string) => { dummyHash ??= hashPassword('senha-inexistente-para-tempo-constante'); await verifyPassword(password, await dummyHash); };

export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (password.length > 200) return 'A senha pode ter no máximo 200 caracteres.';
  return null;
}

export const normalizeEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Limite de tentativas de login ──────────────────────────────────────────────
// Em memória: suficiente para um processo único. Conta falhas por IP e por e-mail.
export class LoginLimiter {
  private failures = new Map<string, { count: number; firstAt: number }>();
  /** Teto de chaves em memória: tentativas com e-mails sempre novos não crescem sem limite. */
  static readonly MAX_KEYS = 10_000;
  constructor(private max = 10, private windowMs = 15 * 60_000, private now = () => Date.now()) {}
  get size() { return this.failures.size; }
  private prune() {
    if (this.failures.size < LoginLimiter.MAX_KEYS) return;
    for (const [key, entry] of this.failures) if (this.now() - entry.firstAt >= this.windowMs) this.failures.delete(key);
    // Ainda cheio: descarta as mais antigas (o Map guarda a ordem de inserção) até sobrar
    // folga de 10%, para a varredura não se repetir a cada tentativa.
    const target = Math.floor(LoginLimiter.MAX_KEYS * 0.9);
    for (const key of this.failures.keys()) {
      if (this.failures.size <= target) break;
      this.failures.delete(key);
    }
  }
  /** Minutos até liberar, ou 0 se pode tentar. */
  blockedFor(keys: string[]) {
    let wait = 0;
    for (const key of keys) {
      const entry = this.failures.get(key);
      if (!entry) continue;
      const elapsed = this.now() - entry.firstAt;
      if (elapsed >= this.windowMs) { this.failures.delete(key); continue; }
      if (entry.count >= this.max) wait = Math.max(wait, Math.ceil((this.windowMs - elapsed) / 60_000));
    }
    return wait;
  }
  fail(keys: string[]) {
    this.prune();
    for (const key of keys) {
      const entry = this.failures.get(key);
      if (!entry || this.now() - entry.firstAt >= this.windowMs) this.failures.set(key, { count: 1, firstAt: this.now() });
      else entry.count++;
    }
  }
  succeed(keys: string[]) { for (const key of keys) this.failures.delete(key); }
}

// ─── Sessões ────────────────────────────────────────────────────────────────────
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// Prazo ABSOLUTO de uma sessão, contado do login. A validade deslizante renova com o uso; sem
// este teto, um cookie roubado e usado todo dia valeria para sempre.
export const SESSION_MAX_AGE_MS = 30 * 24 * 3_600_000;

function readCookie(request: FastifyRequest, name: string) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); }
      catch { return null; }
    }
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string, maxAgeMs: number) {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`];
  if (config.secureCookies) attrs.push('Secure');
  reply.header('Set-Cookie', attrs.join('; '));
}

/** Apaga o cookie de sessão no navegador (logout e exclusão da conta). */
export const clearSessionCookie = (reply: FastifyReply, config: AppConfig) => setSessionCookie(reply, config, '', 0);

async function createSession(db: Prisma.TransactionClient, userId: string, request: FastifyRequest, config: AppConfig) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await db.authSession.create({ data: {
    userId, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + config.sessionTtlMs),
    ip: request.ip?.slice(0, 64) ?? null, userAgent: request.headers['user-agent']?.slice(0, 255) ?? null
  } });
  return token;
}

/** A conta tem sessão aberta a partir deste IP (aparelho que já entrou com a senha certa)? */
async function knownDevice(email: string, ip: string | undefined) {
  if (!ip || !EMAIL.test(email)) return false;
  return Boolean(await prisma.authSession.findFirst({ where: { ip: ip.slice(0, 64), user: { email } }, select: { id: true } }));
}

// Valida o cookie. Renova a sessão quando passou da metade da validade (expiração
// deslizante): quem usa o painel com frequência não é deslogado no meio do trabalho.
async function resolveSession(request: FastifyRequest, reply: FastifyReply, config: AppConfig) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const session = await prisma.authSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
  const now = Date.now();
  if (!session || session.expiresAt.getTime() <= now || session.user.disabledAt) return null;
  const hardLimit = session.createdAt.getTime() + SESSION_MAX_AGE_MS;
  if (hardLimit <= now) {
    await prisma.authSession.deleteMany({ where: { id: session.id } });
    return null;
  }
  if (session.expiresAt.getTime() - now < config.sessionTtlMs / 2) {
    // Renova, mas nunca além do prazo absoluto.
    const expiresAt = Math.min(now + config.sessionTtlMs, hardLimit);
    // Logout, troca de senha ou desativação podem revogar a sessão depois da leitura.
    // Não recria nem renova uma sessão revogada, e responde 401 em vez de erro 500.
    const changed = await prisma.authSession.updateMany({
      where: { id: session.id, expiresAt: { gt: new Date(now) }, user: { disabledAt: null } },
      data: { expiresAt: new Date(expiresAt), lastSeenAt: new Date(now) },
    });
    if (!changed.count) return null;
    setSessionCookie(reply, config, token, expiresAt - now);
  } else if (now - session.lastSeenAt.getTime() > 5 * 60_000) {
    const changed = await prisma.authSession.updateMany({
      where: { id: session.id, expiresAt: { gt: new Date(now) }, user: { disabledAt: null } },
      data: { lastSeenAt: new Date(now) },
    });
    if (!changed.count) return null;
  }
  return publicSessionUser(session.user);
}

// ─── Autorização ────────────────────────────────────────────────────────────────
// Para rotas administrativas: app.get('/api/admin/...', { preHandler: requireSuperAdmin }, ...).
// Roda depois do hook de sessão, então request.user já é o usuário do banco (ou null).
export async function requireSuperAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Faça login para continuar.' });
  if (request.user.role !== 'SUPER_ADMIN') return reply.code(403).send({ error: 'Acesso restrito ao administrador.' });
}

// ─── Rotas e proteção ───────────────────────────────────────────────────────────
export function registerAuth(app: FastifyInstance, config: AppConfig, limiter = new LoginLimiter()) {
  app.decorateRequest('user', null);

  // Sessões vencidas (ou além do prazo absoluto) saem do banco a cada 6 horas.
  const sweep = setInterval(() => {
    const now = new Date();
    void prisma.authSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { createdAt: { lt: new Date(now.getTime() - SESSION_MAX_AGE_MS) } }] } }).catch(() => undefined);
  }, 6 * 3_600_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  // onRequest, ANTES de ler o corpo: sem login, um upload de 200 MB é recusado sem ocupar memória.
  app.addHook('onRequest', async (request, reply) => {
    const url = apiPath(request);
    if (!url.startsWith('/api/') || PUBLIC_API.has(url)) return;
    request.user = await resolveSession(request, reply, config);
    if (!request.user) return reply.code(401).send({ error: 'Faça login para continuar.' });
  });
  // Troca de senha com a senha atual errada: mesmo limite do login, por conta. Uma sessão
  // roubada não vira um jeito de adivinhar a senha atual sem limite.
  const passwordLimiter = new LoginLimiter(5, 15 * 60_000);

  // Público: a tela de login precisa saber se já existe alguém cadastrado.
  app.get('/api/auth/setup', async () => ({ hasUsers: (await prisma.user.count()) > 0 }));

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    const keys = [`ip:${request.ip}`, `email:${email}`];
    // Bloqueio por e-mail sozinho deixaria qualquer um que saiba o e-mail travar o dono fora da
    // conta, errando a senha de outro lugar. De um IP onde esta conta já tem sessão (o próprio
    // computador ou celular), vale só o limite por IP, que continua segurando força bruta.
    let wait = limiter.blockedFor([keys[0]]);
    if (!wait) {
      const emailWait = limiter.blockedFor([keys[1]]);
      if (emailWait && !await knownDevice(email, request.ip)) wait = emailWait;
    }
    if (wait) return reply.code(429).send({ error: `Muitas tentativas. Aguarde ${wait} minuto${wait > 1 ? 's' : ''} e tente de novo.` });
    if (!EMAIL.test(email) || !password || password.length > 200) {
      limiter.fail(keys);
      return reply.code(400).send({ error: 'Informe e-mail e senha.' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    let valid: boolean;
    try {
      valid = user && !user.disabledAt ? await verifyPassword(password, user.passwordHash) : (await burnTime(password), false);
    } catch (error) {
      if (error instanceof ServerBusyError) return reply.code(503).send({ error: error.message });
      throw error;
    }
    if (!user || !valid) {
      limiter.fail(keys);
      return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });
    }
    // A verificação da senha é lenta. Entre ela e a criação da sessão, um administrador pode
    // desativar a conta ou trocar a senha. O lock serializa login e revogação da senha.
    await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const token = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, disabledAt: true } });
      if (!current || current.disabledAt || current.passwordHash !== user.passwordHash) return null;
      return createSession(tx, user.id, request, config);
    });
    if (!token) {
      limiter.fail(keys);
      return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });
    }
    limiter.succeed(keys);
    setSessionCookie(reply, config, token, config.sessionTtlMs);
    return { user: publicSessionUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await prisma.authSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
    setSessionCookie(reply, config, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/me', async request => ({ user: request.user }));

  app.post('/api/auth/password', async (request, reply) => {
    const body = request.body as { current?: unknown; next?: unknown } | null;
    const problem = validateNewPassword(body?.next);
    if (problem) return reply.code(400).send({ error: problem });
    const keys = [`user:${request.user!.id}`];
    const wait = passwordLimiter.blockedFor(keys);
    if (wait) return reply.code(429).send({ error: `Muitas tentativas com a senha atual errada. Aguarde ${wait} minuto${wait > 1 ? 's' : ''}.` });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    try {
      if (typeof body?.current !== 'string' || body.current.length > 200 || !await verifyPassword(body.current, user.passwordHash)) {
        passwordLimiter.fail(keys);
        return reply.code(400).send({ error: 'A senha atual está incorreta.' });
      }
      const nextHash = await hashPassword(body.next as string);
      const changed = await prisma.$transaction(async tx => {
        // Evita que duas trocas simultâneas validem a mesma senha antiga. Sessões e senha
        // mudam juntas ou não mudam, inclusive se o banco falhar no meio.
        await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`;
        const updated = await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash: nextHash } });
        if (!updated.count) return false;
        const current = readCookie(request, SESSION_COOKIE);
        await tx.authSession.deleteMany({ where: { userId: user.id, NOT: { tokenHash: tokenHash(current ?? '') } } });
        await tx.passwordReset.deleteMany({ where: { userId: user.id } });
        return true;
      });
      if (!changed) return reply.code(409).send({ error: 'A senha foi alterada em outra sessão. Entre novamente e tente de novo.' });
      passwordLimiter.succeed(keys);
    } catch (error) {
      if (error instanceof ServerBusyError) return reply.code(503).send({ error: error.message });
      throw error;
    }
    return { ok: true };
  });
}

// Primeira subida sem nenhum usuário: cria o SUPER_ADMIN a partir de ADMIN_EMAIL/ADMIN_PASSWORD.
// Idempotente — com qualquer usuário já cadastrado, não faz nada.
export async function bootstrapAdmin(env: NodeJS.ProcessEnv, log: (message: string) => void = console.log) {
  if (await prisma.user.count()) return 'exists' as const;
  const email = normalizeEmail(env.ADMIN_EMAIL);
  if (!email || !env.ADMIN_PASSWORD) {
    log('Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_PASSWORD e reinicie, ou rode: npm run user:create');
    return 'missing' as const;
  }
  if (!EMAIL.test(email)) throw new Error('ADMIN_EMAIL não é um e-mail válido.');
  const problem = validateNewPassword(env.ADMIN_PASSWORD);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  await prisma.user.create({ data: { email, name: env.ADMIN_NAME?.trim() || 'Administrador', role: 'SUPER_ADMIN', passwordHash: await hashPassword(env.ADMIN_PASSWORD) } });
  log(`Usuário administrador ${email} criado. Por segurança, remova ADMIN_PASSWORD das variáveis de ambiente.`);
  return 'created' as const;
}
