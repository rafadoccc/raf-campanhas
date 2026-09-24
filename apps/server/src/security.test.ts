import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { publicMessage } from './security';
import { LoginLimiter } from './auth';
import { loadConfig, TRUSTED_PROXIES } from './config';

test('publicMessage: business messages go to the screen; system details never do', () => {
  assert.equal(publicMessage(new Error('Conecte o WhatsApp primeiro.'), 'x'), 'Conecte o WhatsApp primeiro.');
  const vazamentos = [
    Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\rafad\\AppData\\x'"), { code: 'ENOENT', errno: -4058, syscall: 'open' }),
    new Error('EACCES: permission denied'),
    new Error("falhou em C:\\Users\\rafad\\projeto\\arquivo"),
    new Error('falhou em /home/app/sessions/users/abc'),
    new Error('Cannot find module node_modules/x'),
    new Error('Invalid `prisma.user.findMany()` invocation'),
    new Error('connect ECONNREFUSED 127.0.0.1:3306'),
  ];
  for (const error of vazamentos) assert.equal(publicMessage(error, 'Falha genérica.'), 'Falha genérica.', error.message);
  assert.equal(publicMessage('texto solto', 'Falha genérica.'), 'Falha genérica.');
});

test('login limiter: blocks after repeated failures and never grows without bound', () => {
  let now = 0;
  const limiter = new LoginLimiter(3, 60_000, () => now);
  for (let i = 0; i < 3; i++) limiter.fail(['ip:1', 'email:a@x']);
  assert.ok(limiter.blockedFor(['ip:1']) > 0, 'bloqueia depois do limite');
  now = 60_001;
  assert.equal(limiter.blockedFor(['ip:1']), 0, 'libera depois da janela');
  // Um atacante trocando de e-mail a cada tentativa: a memória tem teto.
  for (let i = 0; i < LoginLimiter.MAX_KEYS * 2; i++) limiter.fail([`email:${i}@spam`]);
  assert.ok(limiter.size <= LoginLimiter.MAX_KEYS, `chaves em memória: ${limiter.size}`);
});

test('proxy trust: the client can never choose its own IP through X-Forwarded-For', async () => {
  const deployed = loadConfig({ PUBLIC_URL: 'https://campanhas.exemplo.com.br' });
  assert.equal(deployed.trustProxy, TRUSTED_PROXIES);
  assert.equal(loadConfig({}).trustProxy, false, 'no PC não confia em proxy nenhum');
  assert.equal(loadConfig({ TRUST_PROXY: '0', PUBLIC_URL: 'https://x.com.br' }).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, TRUSTED_PROXIES, "o antigo '1' agora quer dizer rede interna, não 'qualquer um'");
  const app = Fastify({ trustProxy: deployed.trustProxy });
  app.get('/ip', async request => ({ ip: request.ip }));
  // Pela borda da hospedagem (rede interna): vale o IP que o proxy acrescentou.
  const viaProxy = await app.inject({ url: '/ip', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 200.1.1.1' } });
  assert.equal(viaProxy.json().ip, '200.1.1.1');
  // Direto da internet, forjando o cabeçalho: vale o IP verdadeiro da conexão.
  const forjado = await app.inject({ url: '/ip', remoteAddress: '200.9.9.9', headers: { 'x-forwarded-for': '6.6.6.6' } });
  assert.equal(forjado.json().ip, '200.9.9.9');
  await app.close();
});
