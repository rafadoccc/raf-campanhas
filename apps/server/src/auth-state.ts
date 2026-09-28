import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';

// Sessão do WhatsApp em arquivos, à prova de queda (ADR-036). Mesmo formato e mesmos nomes de
// arquivo do useMultiFileAuthState do Baileys: uma sessão já pareada continua valendo, sem
// migração. O que muda:
//
// - Gravação atômica: escreve num arquivo temporário e troca pelo definitivo (rename). Antes, o
//   processo encerrado no meio de uma gravação (janela fechada, PC desligado, atualização)
//   deixava o arquivo pela metade.
// - creds.json com cópia de segurança (creds.json.bak) e fsync no disco. Credencial ilegível
//   volta pela cópia.
// - Nunca troca em silêncio uma sessão pareada por uma nova. O Baileys fazia
//   `lerCreds() || novaCredencial()`: um creds.json corrompido virava uma identidade nova, o
//   WhatsApp pedia QR ("O QR Code expirou…") e a gravação seguinte apagava o pareamento antigo.
//   Aqui o arquivo ilegível é guardado à parte e o motivo fica registrado.

type Baileys = {
  initAuthCreds: () => AuthenticationCreds;
  BufferJSON: { replacer: (key: string, value: unknown) => unknown; reviver: (key: string, value: unknown) => unknown };
  proto: { Message: { AppStateSyncKeyData: { fromObject: (value: { [key: string]: any }) => unknown } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export type CredsSource = 'saved' | 'backup' | 'new' | 'unreadable';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']); // antivírus/indexador segurando o arquivo no Windows
const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-');

// Um arquivo por vez: leituras e gravações do mesmo arquivo nunca se cruzam.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  locks.set(file, settled);
  void settled.then(() => { if (locks.get(file) === settled) locks.delete(file); });
  return run;
}

async function renameWithRetry(from: string, to: string) {
  for (let attempt = 1; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (attempt >= 6 || !RETRYABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * attempt));
    }
  }
}

/** Grava por inteiro ou não grava: temporário + rename. `durable` força o disco (fsync). */
export async function writeAtomic(file: string, content: string, durable = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      if (durable) await handle.sync();
    } finally { await handle.close(); }
    await renameWithRetry(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function useDurableAuthState(folder: string, baileys: Baileys, log: (message: string) => void = console.warn) {
  const info = await stat(folder).catch(() => null);
  if (info && !info.isDirectory()) throw new Error(`Há um arquivo no lugar da pasta de sessão: ${folder}`);
  if (!info) await mkdir(folder, { recursive: true, mode: 0o700 });

  const full = (file: string) => path.join(folder, fixFileName(file));
  const parse = (text: string) => JSON.parse(text, baileys.BufferJSON.reviver);
  const serialize = (value: unknown) => JSON.stringify(value, baileys.BufferJSON.replacer);

  const readData = (file: string) => withLock(full(file), async () => {
    try { return parse(await readFile(full(file), 'utf8')); }
    catch { return null; } // chave ausente ou ilegível: o Baileys pede de novo ao WhatsApp
  });
  const writeData = (value: unknown, file: string) => withLock(full(file), () => writeAtomic(full(file), serialize(value)));
  const removeData = (file: string) => withLock(full(file), () => unlink(full(file)).catch(() => undefined));

  // ─── Credencial: o arquivo que, perdido, obriga a ler o QR de novo ───
  const credsFile = full('creds.json');
  const backupFile = `${credsFile}.bak`;
  let source: CredsSource = 'new';
  let creds: AuthenticationCreds | null = null;
  const tryRead = async (file: string) => {
    try { return parse(await readFile(file, 'utf8')) as AuthenticationCreds; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null; } // undefined = não existe; null = ilegível
  };
  const main = await tryRead(credsFile);
  if (main) { creds = main; source = 'saved'; }
  else {
    const backup = await tryRead(backupFile);
    if (backup) {
      creds = backup; source = 'backup';
      log(`[WhatsApp] creds.json ${main === null ? 'ilegível' : 'ausente'} em ${folder}: sessão restaurada da cópia de segurança.`);
      await writeAtomic(credsFile, serialize(backup), true);
    } else if (main === null) {
      // Ilegível e sem cópia: guarda o arquivo (não apaga) e começa do zero — vai pedir QR.
      source = 'unreadable';
      const quarantine = `${credsFile}.ilegivel-${Date.now()}`;
      await renameWithRetry(credsFile, quarantine).catch(() => undefined);
      log(`[WhatsApp] creds.json ilegível em ${folder} e sem cópia de segurança; guardado como ${path.basename(quarantine)}. Será preciso ler o QR.`);
    }
  }
  const state: AuthenticationState = {
    creds: creds ?? baileys.initAuthCreds(),
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const data: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(ids.map(async id => {
          let value = await readData(`${type}-${id}.json`);
          if (type === 'app-state-sync-key' && value) value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value);
          data[id] = value;
        }));
        return data;
      },
      set: async data => {
        const tasks: Promise<unknown>[] = [];
        for (const category in data) {
          const entries = data[category as keyof SignalDataTypeMap] ?? {};
          for (const id in entries) {
            const value = entries[id];
            const file = `${category}-${id}.json`;
            tasks.push(value ? writeData(value, file) : removeData(file));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  /** Grava a credencial no disco (fsync) e renova a cópia de segurança. */
  const saveCreds = () => withLock(credsFile, async () => {
    const content = serialize(state.creds);
    await writeAtomic(credsFile, content, true);
    await writeAtomic(backupFile, content, true);
  });

  return { state, saveCreds, source };
}
