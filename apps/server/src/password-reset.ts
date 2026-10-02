import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma, LOCKING_TRANSACTION } from '@campaign/database';
import type { AppConfig } from './config';
import { LoginLimiter, hashPassword, normalizeEmail, requireSuperAdmin, validateNewPassword } from './auth';
import { sendMail, type Message } from './mailer';

// "Esqueci minha senha" (ADR-047). A pessoa cria a senha nova por um LINK de uso único; ninguém
// (nem o administrador) fica sabendo a senha. O link chega de um de dois jeitos:
//   - com e-mail configurado (RESEND_API_KEY + MAIL_FROM): vai por e-mail, vale 1 hora;
//   - sem e-mail: o pedido aparece para o administrador, que gera o link (vale 24 horas) e manda
//     pelo canal que já usa com o cliente (WhatsApp).
// O pedido responde sempre igual, exista a conta ou não: não dá para descobrir e-mails cadastrados.

export const RESET_TTL_MS = { email: 60 * 60_000, admin: 24 * 3_600_000 } as const;
/** Pedido sem link que ninguém atendeu some depois disto. */
const REQUEST_KEEP_MS = 7 * 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{30,100}$/;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Cria o link (invalida os anteriores e o pedido pendente da conta) e devolve o endereço. */
async function issueLink(config: AppConfig, userId: string, ttlMs: number) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  const issued = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { disabledAt: true } });
    if (!user || user.disabledAt) return false;
    await tx.passwordReset.deleteMany({ where: { userId } });
    await tx.passwordReset.create({ data: { userId, tokenHash: hashOf(token), expiresAt } });
    return true;
  }, LOCKING_TRANSACTION);
  if (!issued) return null;
  return { url: `${config.publicUrl.origin}/redefinir-senha/${token}`, expiresAt };
}

/** Link ainda válido, de conta ativa. */
const findValid = (token: string) => (TOKEN.test(token)
  ? prisma.passwordReset.findFirst({ where: { tokenHash: hashOf(token), expiresAt: { gt: new Date() }, user: { disabledAt: null } }, select: { id: true, userId: true, user: { select: { name: true } } } })
  : Promise.resolve(null));

type Options = { limiter?: LoginLimiter; send?: (message: Message) => Promise<void> };

export function registerPasswordReset(app: FastifyInstance, config: AppConfig, options: Options = {}) {
  // 5 pedidos por IP e por e-mail a cada 15 min: sem isso, viraria um jeito de encher a caixa de
  // alguém (ou a lista do administrador) e de invalidar o link de outra pessoa sem parar.
  const limiter = options.limiter ?? new LoginLimiter(5, 15 * 60_000);
  const send = options.send ?? (config.mail ? (message: Message) => sendMail(config.mail!, message) : null);

  app.post('/api/auth/forgot', async (request, reply) => {
    const email = normalizeEmail((request.body as { email?: unknown } | null)?.email);
    const keys = [`ip:${request.ip}`, `email:${email}`];
    const wait = limiter.blockedFor(keys);
    if (wait) return reply.code(429).send({ error: `Muitos pedidos. Aguarde ${wait} minuto${wait > 1 ? 's' : ''} e tente de novo.` });
    limiter.fail(keys); // todo pedido conta, com ou sem conta por trás
    const user = EMAIL.test(email) ? await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, disabledAt: true } }) : null;
    if (user && !user.disabledAt) {
      await prisma.passwordReset.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - REQUEST_KEEP_MS) } } }).catch(() => undefined);
      if (send) {
        const link = await issueLink(config, user.id, RESET_TTL_MS.email);
        if (!link) return { ok: true, delivery: 'email' };
        const { url } = link;
        // Sem esperar o envio: o tempo de resposta não pode revelar se a conta existe.
        void send({
          to: email, subject: 'DocDrop: criar uma nova senha',
          text: `Olá, ${user.name}.\n\nRecebemos um pedido para criar uma nova senha no DocDrop. Abra o link abaixo (vale por 1 hora e só funciona uma vez):\n\n${url}\n\nSe não foi você, ignore este e-mail: a sua senha continua a mesma.`,
        }).catch(error => console.error('[E-mail] Não foi possível enviar o link de nova senha:', error instanceof Error ? error.message : error));
      } else {
        // Sem e-mail: fica o pedido para o administrador (um por conta, sem acumular).
        await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${user.id} FOR UPDATE`;
          const current = await tx.user.findUnique({ where: { id: user.id }, select: { disabledAt: true } });
          if (!current || current.disabledAt) return;
          if (!await tx.passwordReset.count({ where: { userId: user.id, tokenHash: null } })) {
            await tx.passwordReset.create({ data: { userId: user.id } });
          }
        }, LOCKING_TRANSACTION);
      }
    }
    // delivery diz só COMO o sistema entrega links (igual para qualquer e-mail digitado).
    return { ok: true, delivery: send ? 'email' : 'admin' };
  });

  // A tela do link confere se ele ainda vale antes de pedir a senha nova.
  app.get('/api/auth/reset/:token', async (request, reply) => {
    const reset = await findValid((request.params as { token: string }).token);
    if (!reset) return reply.code(404).send({ error: 'Este link não vale mais. Peça um novo.' });
    return { valid: true, name: reset.user.name.split(' ')[0] };
  });

  app.post('/api/auth/reset/:token', async (request, reply) => {
    const password = (request.body as { password?: unknown } | null)?.password;
    const problem = validateNewPassword(password);
    if (problem) return reply.code(400).send({ error: problem });
    const reset = await findValid((request.params as { token: string }).token);
    if (!reset) return reply.code(404).send({ error: 'Este link não vale mais. Peça um novo.' });
    const passwordHash = await hashPassword(password as string); // lento: fora da transação
    const done = await prisma.$transaction(async tx => {
      // Mesma trava do login e da troca de senha: a conta muda de senha uma vez, e inteira.
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${reset.userId} FOR UPDATE`;
      // Uso único: quem apagar a linha do link é quem troca a senha (dois cliques não trocam duas vezes).
      if (!(await tx.passwordReset.deleteMany({ where: { id: reset.id, expiresAt: { gt: new Date() } } })).count) return false;
      const { count } = await tx.user.updateMany({ where: { id: reset.userId, disabledAt: null }, data: { passwordHash } });
      if (!count) return false;
      // Senha nova derruba todas as sessões abertas e qualquer outro pedido ou link da conta.
      await tx.authSession.deleteMany({ where: { userId: reset.userId } });
      await tx.passwordReset.deleteMany({ where: { userId: reset.userId } });
      return true;
    }, LOCKING_TRANSACTION);
    if (!done) return reply.code(404).send({ error: 'Este link não vale mais. Peça um novo.' });
    return { ok: true };
  });

  // Administrador gera o link para mandar ao cliente (quando não há e-mail, ou a pedido).
  app.post('/api/admin/users/:id/reset-link', { preHandler: requireSuperAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user!.id) return reply.code(400).send({ error: 'Troque a sua senha em Minha conta.' });
    const user = await prisma.user.findUnique({ where: { id }, select: { disabledAt: true } });
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    if (user.disabledAt) return reply.code(400).send({ error: 'Reative a conta antes de gerar o link.' });
    const link = await issueLink(config, id, RESET_TTL_MS.admin);
    if (!link) return reply.code(400).send({ error: 'Reative a conta antes de gerar o link.' });
    return link;
  });
}
