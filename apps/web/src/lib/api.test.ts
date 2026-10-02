import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, invalidateAuthorizationRequests, setUnauthorizedHandler } from './api';

test('401 atrasado de uma sessão anterior não encerra o login atual', async () => {
  const original = globalThis.fetch;
  let respond!: (response: Response) => void;
  let logouts = 0;
  setUnauthorizedHandler(() => { logouts++; });
  globalThis.fetch = async () => new Promise<Response>(resolve => { respond = resolve; });
  try {
    const request = api('/campaigns');
    const refused = assert.rejects(request, error => error instanceof ApiError && error.status === 401);
    invalidateAuthorizationRequests(); // Login novo, logout ou troca de conta.
    respond(new Response(JSON.stringify({ error: 'Sessão encerrada.' }), { status: 401 }));
    await refused;
    assert.equal(logouts, 0);
  } finally { globalThis.fetch = original; setUnauthorizedHandler(() => undefined); }
});

test('401 da sessão atual encerra o painel, mas senha incorreta no login não', async () => {
  const original = globalThis.fetch;
  let logouts = 0;
  setUnauthorizedHandler(() => { logouts++; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 });
  try {
    await assert.rejects(api('/campaigns'), ApiError);
    assert.equal(logouts, 1);
    await assert.rejects(api('/auth/login', { method: 'POST', json: { email: 'teste@example.com', password: 'senha-incorreta' } }), ApiError);
    assert.equal(logouts, 1);
  } finally { globalThis.fetch = original; setUnauthorizedHandler(() => undefined); }
});
