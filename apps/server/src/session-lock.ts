import { hostname } from 'node:os';
import { readFile, stat, unlink } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

// mkdir garante exclusividade entre processos. A biblioteca renova o mtime e detecta
// perda de posse. O caminho é o mesmo .lock da versão antiga, agora um diretório.
export const LOCK_HEARTBEAT_MS = 60_000;
export const LOCK_STALE_MS = 3 * 60_000;

type LockOwner = { pid: number; host: string; at: number };
export type LockResult = { ok: true } | { ok: false; owner: LockOwner };

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Compatibilidade com o antigo .lock em JSON durante a primeira reinicialização. */
export function lockHeld(owner: LockOwner, now = Date.now(), self = { pid: process.pid, host: hostname() }, isAlive = alive) {
  if (owner.pid === self.pid && owner.host === self.host) return false;
  if (owner.host === self.host) return isAlive(owner.pid);
  return now - owner.at <= LOCK_STALE_MS;
}

export class SessionLock {
  private unlock?: () => Promise<void>;
  constructor(readonly file: string) {}

  private async legacyOwner(): Promise<LockOwner | null> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LockOwner>;
      return typeof data.pid === 'number' && typeof data.host === 'string' && typeof data.at === 'number'
        ? data as LockOwner : null;
    } catch { return null; }
  }

  async acquire(): Promise<LockResult> {
    if (this.unlock) return { ok: true };

    const existing = await stat(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing?.isFile()) {
      const owner = await this.legacyOwner();
      if (owner ? lockHeld(owner) : Date.now() - existing.mtimeMs <= LOCK_STALE_MS) {
        return { ok: false, owner: owner ?? { pid: 0, host: 'outra instância', at: existing.mtimeMs } };
      }
      // Só remove trava antiga abandonada. A versão antiga não consegue sobrescrever
      // o diretório que passa a ocupar esse caminho.
      await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }

    try {
      this.unlock = await lockfile.lock(this.file, {
        realpath: false,
        lockfilePath: this.file,
        stale: LOCK_STALE_MS,
        update: LOCK_HEARTBEAT_MS,
      });
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      const owner = await this.legacyOwner();
      return { ok: false, owner: owner ?? { pid: 0, host: 'outra instância', at: Date.now() } };
    }
  }

  async release() {
    const unlock = this.unlock;
    this.unlock = undefined;
    if (unlock) await unlock();
  }
}
