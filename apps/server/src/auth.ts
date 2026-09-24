import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@campaign/database';
import type { AppConfig } from './config';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const SESSION_COOKIE = 'campanhas_sessao';
// Rotas da API acessíveis sem login. Todo o resto exige sessão (negar por padrão).
const PUBLIC_API = new Set(['/api/health', '/api/auth/login', '/api/auth/setup']);

// Papéis (ADR-016). O papel vem SEMPRE do banco, pela sessão validada no servidor; nada que o
// navegador envie (corpo, cabeçalho, cookie próprio) decide permissão.
export type Role = 'SUPER_ADMIN' | 'USER';
export type SessionUser = { id: string; email: string; name: string; role: Role };
declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null }
}

// ─── Senhas ──────────────────────────────────────────────────────────────────────
// scrypt N=2^15, r=8, p=1: ~32 MB e ~0,1 s por verificação. Custo alto o bastante para
// atrasar força bruta, baixo o bastante para hospedagem compartilhada.
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD = 10;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, KDF);
  return `scrypt$${KDF.N}$${KDF.r}$${KDF.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: KDF.maxmem });
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
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string, maxAgeMs: number) {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`];
  if (config.secureCookies) attrs.push('Secure');
  reply.header('Set-Cookie', attrs.join('; '));
}

async function createSession(userId: string, request: FastifyRequest, config: AppConfig) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await prisma.authSession.create({ data: {
    userId, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + config.sessionTtlMs),
    ip: request.ip?.slice(0, 64) ?? null, userAgent: request.headers['user-agent']?.slice(0, 255) ?? null
  } });
  return token;
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
    await prisma.authSession.update({ where: { id: session.id }, data: { expiresAt: new Date(expiresAt), lastSeenAt: new Date(now) } });
    setSessionCookie(reply, config, token, expiresAt - now);
  } else if (now - session.lastSeenAt.getTime() > 5 * 60_000) {
    await prisma.authSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
  }
  const { id, email, name, role } = session.user;
  return { id, email, name, role };
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

  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api/') || PUBLIC_API.has(url)) return;
    request.user = await resolveSession(request, reply, config);
    if (!request.user) return reply.code(401).send({ error: 'Faça login para continuar.' });
  });

  // Público: a tela de login precisa saber se já existe alguém cadastrado.
  app.get('/api/auth/setup', async () => ({ hasUsers: (await prisma.user.count()) > 0 }));

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    const keys = [`ip:${request.ip}`, `email:${email}`];
    const wait = limiter.blockedFor(keys);
    if (wait) return reply.code(429).send({ error: `Muitas tentativas. Aguarde ${wait} minuto${wait > 1 ? 's' : ''} e tente de novo.` });
    if (!EMAIL.test(email) || !password || password.length > 200) {
      limiter.fail(keys);
      return reply.code(400).send({ error: 'Informe e-mail e senha.' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    const valid = user && !user.disabledAt ? await verifyPassword(password, user.passwordHash) : (await burnTime(password), false);
    if (!user || !valid) {
      limiter.fail(keys);
      return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });
    }
    limiter.succeed(keys);
    await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    setSessionCookie(reply, config, await createSession(user.id, request, config), config.sessionTtlMs);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
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
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    if (typeof body?.current !== 'string' || !await verifyPassword(body.current, user.passwordHash)) return reply.code(400).send({ error: 'A senha atual está incorreta.' });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.next as string) } });
    // Encerra as outras sessões: quem trocou a senha por suspeita não fica com intrusos logados.
    const current = readCookie(request, SESSION_COOKIE);
    await prisma.authSession.deleteMany({ where: { userId: user.id, NOT: { tokenHash: tokenHash(current ?? '') } } });
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
