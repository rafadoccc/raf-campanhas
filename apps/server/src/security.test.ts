import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { publicMessage, registerSecurity } from './security';
import { Gate, LoginLimiter, ServerBusyError, registerAuth } from './auth';
import { RateLimiter } from './rate-limit';
import { loadConfig, TRUSTED_PROXIES } from './config';

test('encoded API paths receive origin, rate limit and authentication checks', async () => {
  const app = Fastify();
  const config = loadConfig({});
  registerSecurity(app, config, new RateLimiter(2, 0));
  registerAuth(app, config);
  app.post('/api/probe', async () => ({ reached: true }));

  const normal = await app.inject({ method: 'POST', url: '/api/probe', payload: {} });
  assert.equal(normal.statusCode, 403);
  const encoded = await app.inject({ method: 'POST', url: '/%61pi/probe', payload: {} });
  assert.equal(encoded.statusCode, 403, 'a URL codificada exige Origin');

  const authenticated = await app.inject({
    method: 'POST', url: '/%61pi/probe', payload: {},
    headers: { origin: config.publicUrl.origin },
  });
  assert.equal(authenticated.statusCode, 401, 'a URL codificada exige login');
  const second = await app.inject({
    method: 'POST', url: '/%61pi/probe', payload: {},
    headers: { origin: config.publicUrl.origin },
  });
  assert.equal(second.statusCode, 401);
  const limited = await app.inject({
    method: 'POST', url: '/%61pi/probe', payload: {},
    headers: { origin: config.publicUrl.origin },
  });
  assert.equal(limited.statusCode, 429, 'a URL codificada consome o limite da API');
  await app.close();
});

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

test('rate limiter: allows bursts, refills over time, blocks floods and caps memory', () => {
  let now = 0;
  const limiter = new RateLimiter(10, 2, () => now);
  for (let i = 0; i < 10; i++) assert.ok(limiter.take('1.1.1.1'), `rajada ${i}`);
  assert.equal(limiter.take('1.1.1.1'), false, 'estourou o balde');
  assert.ok(limiter.take('2.2.2.2'), 'outro IP não é afetado');
  assert.ok(limiter.retryAfter('1.1.1.1') >= 1);
  now = 1_000; // 1 s depois: +2 fichas
  assert.ok(limiter.take('1.1.1.1'));
  assert.ok(limiter.take('1.1.1.1'));
  assert.equal(limiter.take('1.1.1.1'), false);
  for (let i = 0; i < RateLimiter.MAX_KEYS * 2; i++) limiter.take(`ip-${i}`);
  assert.ok(limiter.size <= RateLimiter.MAX_KEYS, `IPs em memória: ${limiter.size}`);
});

test('gate: never runs more than the limit at once and refuses beyond the queue', async () => {
  const gate = new Gate(2, 1);
  let running = 0, peak = 0;
  const releases: (() => void)[] = [];
  const task = () => gate.run(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise<void>(resolve => releases.push(resolve));
    running--;
    return 'ok';
  });
  const first = [task(), task(), task()]; // 2 rodando, 1 na fila
  await assert.rejects(task(), ServerBusyError, 'fila cheia recusa na hora');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.load.running, 2); assert.equal(gate.load.waiting, 1);
  while (releases.length || gate.load.running) { releases.shift()?.(); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(await Promise.all(first), ['ok', 'ok', 'ok']);
  assert.equal(peak, 2, 'nunca mais de 2 ao mesmo tempo');
  assert.deepEqual(gate.load, { running: 0, waiting: 0 }, 'libera tudo no fim');
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
  // Borda do Railway (faixa interna de operadora): também é proxy confiável.
  const railway = await app.inject({ url: '/ip', remoteAddress: '100.64.0.7', headers: { 'x-forwarded-for': '201.2.3.4' } });
  assert.equal(railway.json().ip, '201.2.3.4');
  await app.close();
});
