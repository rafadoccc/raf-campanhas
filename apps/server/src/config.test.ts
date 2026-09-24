import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, TRUSTED_PROXIES } from './config';

test('local (sem variáveis): porta 3000, só 127.0.0.1, endereço localhost', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.publicUrl.origin, 'http://localhost:3000');
  assert.equal(config.deployed, false);
});

test('PORT do ambiente é respeitada; local continua em 127.0.0.1', () => {
  const config = loadConfig({ PORT: '8080' });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
});

test('Railway: escuta em 0.0.0.0 na PORT dada e usa o domínio público como PUBLIC_URL', () => {
  const config = loadConfig({ PORT: '8080', RAILWAY_ENVIRONMENT_ID: 'env-1', RAILWAY_PUBLIC_DOMAIN: 'campanhas-production.up.railway.app' });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.publicUrl.origin, 'https://campanhas-production.up.railway.app');
  assert.equal(config.deployed, true);
  assert.ok(config.allowedOrigins.includes('https://campanhas-production.up.railway.app'));
  assert.equal(config.allowedHosts, null, 'Host do proxy não é barrado');
  assert.equal(config.secureCookies, true);
  assert.equal(config.trustProxy, TRUSTED_PROXIES, 'só proxies da rede interna');
});

test('Railway sem domínio público ainda escuta em 0.0.0.0; PUBLIC_URL e HOST têm prioridade', () => {
  assert.equal(loadConfig({ RAILWAY_ENVIRONMENT: 'production' }).host, '0.0.0.0');
  const custom = loadConfig({ RAILWAY_ENVIRONMENT_ID: 'env-1', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', PUBLIC_URL: 'https://campanhas.meudominio.com.br', HOST: '::' });
  assert.equal(custom.publicUrl.origin, 'https://campanhas.meudominio.com.br');
  assert.equal(custom.host, '::');
});

test('publicado fora do Railway (PUBLIC_URL) continua em 0.0.0.0', () => {
  assert.equal(loadConfig({ PUBLIC_URL: 'https://campanhas.meudominio.com.br' }).host, '0.0.0.0');
});
