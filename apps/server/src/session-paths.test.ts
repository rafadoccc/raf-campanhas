import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { whatsappSessionDir, usersSessionsRoot, legacyWhatsappSessionDir } from './session-paths';

const BASE = path.join('C:', 'sessoes-de-teste');
const VALID = 'cmubh0d9o004o3xzg1tb13n3s'; // formato real de id (cuid)

test('session path: one folder per user, built only from the internal id', () => {
  const dir = whatsappSessionDir(VALID, BASE);
  assert.equal(dir, path.resolve(BASE, 'users', VALID, 'whatsapp'));
  assert.ok(dir.startsWith(usersSessionsRoot(BASE)), 'fica dentro da pasta de sessões');
  assert.notEqual(whatsappSessionDir('outro-usuario-id', BASE), dir, 'usuários diferentes, pastas diferentes');
  // Separador nativo: barra invertida no Windows, barra no Linux.
  assert.ok(dir.endsWith(path.join('users', VALID, 'whatsapp')));
});

test('session path: the legacy global folder stays untouched and separate', () => {
  assert.equal(legacyWhatsappSessionDir(BASE), path.join(path.resolve(BASE), 'whatsapp'));
  assert.notEqual(legacyWhatsappSessionDir(BASE), whatsappSessionDir(VALID, BASE));
  assert.ok(!whatsappSessionDir(VALID, BASE).startsWith(legacyWhatsappSessionDir(BASE)), 'a pasta do usuário não fica dentro da antiga');
});

test('session path: refuses ids that could escape the sessions folder or come from e-mail/name', () => {
  const recusados = [
    '..', '../..', '../outro', 'a/../../b', 'a/b', 'a\\b', '.', './x',
    path.join('C:', 'Windows'), '/etc/passwd', 'C:\\Windows\\System32',
    'rafadocphoto@gmail.com', 'Rafael Silva', 'nome.com.ponto', 'id:com:dois-pontos',
    '', ' ', 'a'.repeat(65), 'id\u0000nulo', 'acentuação',
  ];
  for (const id of recusados) {
    assert.throws(() => whatsappSessionDir(id, BASE), /inválido|fora da pasta/, `deveria recusar: ${JSON.stringify(id)}`);
  }
  // Nada do que foi recusado pode ter virado caminho válido.
  for (const id of recusados) {
    let dir: string | null = null;
    try { dir = whatsappSessionDir(id, BASE); } catch { /* esperado */ }
    assert.equal(dir, null);
  }
});

test('session path: the sessions root comes from the environment, not from the user', () => {
  const outra = path.join('D:', 'dados', 'sessions');
  assert.ok(whatsappSessionDir(VALID, outra).startsWith(path.resolve(outra)));
  assert.equal(path.relative(usersSessionsRoot(outra), whatsappSessionDir(VALID, outra)), path.join(VALID, 'whatsapp'));
});
