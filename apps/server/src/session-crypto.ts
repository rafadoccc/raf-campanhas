import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Sessão do WhatsApp cifrada em repouso (ADR-046, T-024). Com SESSION_KEY definida, os arquivos da
// sessão (credencial e chaves) são gravados cifrados com AES-256-GCM. Quem copiar a pasta de
// sessões ou um backup dela, sem a chave, não consegue usar o WhatsApp do cliente.
//
// É OPCIONAL: sem SESSION_KEY tudo continua em texto puro, como sempre foi. E é compatível nos dois
// sentidos da leitura: um arquivo em texto puro continua sendo lido depois de ligar a chave (e é
// regravado cifrado). O contrário NÃO vale: arquivo cifrado sem a chave certa não é lido — e isso
// é um erro explícito (SessionKeyError), nunca "sessão ilegível", para o sistema jamais trocar
// uma sessão boa por uma nova só porque a chave faltou.

const PREFIX = 'enc:v1:';
const MIN_KEY_LENGTH = 32;
// O sal fixo só separa esta derivação de outras; a força vem da própria SESSION_KEY (longa e aleatória).
const SALT = 'docdrop-sessao-whatsapp-v1';

export class SessionKeyError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionKeyError'; }
}

let cached: { source: string; key: Buffer } | null = null;
/** Chave derivada de SESSION_KEY, ou null quando a cifra está desligada. */
function sessionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const source = env.SESSION_KEY?.trim();
  if (!source) return null;
  if (source.length < MIN_KEY_LENGTH) throw new SessionKeyError(`SESSION_KEY precisa ter pelo menos ${MIN_KEY_LENGTH} caracteres. Gere uma com: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`);
  if (cached?.source !== source) cached = { source, key: scryptSync(source, SALT, 32) };
  return cached.key;
}

export const sessionEncryptionEnabled = (env: NodeJS.ProcessEnv = process.env) => sessionKey(env) !== null;
export const isSealed = (stored: string) => stored.startsWith(PREFIX);

/** Texto pronto para gravar: cifrado se houver chave, igual ao original se não houver. */
export function sealText(plain: string, env: NodeJS.ProcessEnv = process.env) {
  const key = sessionKey(env);
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Texto original de um arquivo da sessão, cifrado ou não. */
export function openText(stored: string, env: NodeJS.ProcessEnv = process.env) {
  if (!isSealed(stored)) return stored;
  const key = sessionKey(env);
  if (!key) throw new SessionKeyError('A sessão do WhatsApp está cifrada e a SESSION_KEY não foi definida. Defina a mesma chave usada antes.');
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new SessionKeyError('A sessão do WhatsApp foi cifrada com outra SESSION_KEY. Volte a chave anterior.');
  }
}
