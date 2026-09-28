import { hostname } from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import { writeAtomic } from './auth-state';

// Uma pasta de sessão, um processo (ADR-036).
//
// Duas instâncias do sistema com a mesma pasta de sessões (produção e dev no mesmo computador
// sem SESSIONS_DIR próprio, ou um deploy novo subindo antes de o antigo sair) abririam duas
// conexões com as MESMAS credenciais: o WhatsApp derruba uma com a outra (erro 440) e as duas
// gravam as mesmas chaves ao mesmo tempo, o que estraga a sessão. A trava é um arquivo ao lado
// da pasta (`<pasta>.lock`) com o processo dono e um sinal de vida renovado a cada minuto.
//
// Uma trava vale enquanto o sinal de vida é recente E o dono existe: no mesmo computador o
// processo precisa estar vivo; em outro computador (volume compartilhado) só o sinal decide.
// Processo que morreu sem soltar (janela fechada, queda de energia) não segura nada: no mesmo
// computador a trava cai na hora; em outro, em até LOCK_STALE_MS.

export const LOCK_HEARTBEAT_MS = 60_000;
export const LOCK_STALE_MS = 3 * 60_000;

type LockOwner = { pid: number; host: string; at: number };
export type LockResult = { ok: true } | { ok: false; owner: LockOwner };

const me = () => ({ pid: process.pid, host: hostname() });

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function lockHeld(owner: LockOwner, now = Date.now(), self = me(), isAlive = alive) {
  if (owner.pid === self.pid && owner.host === self.host) return false; // é deste processo
  if (now - owner.at > LOCK_STALE_MS) return false;
  if (owner.host === self.host) return isAlive(owner.pid);
  return true;
}

export class SessionLock {
  private timer?: NodeJS.Timeout;
  constructor(readonly file: string) {}

  private async owner(): Promise<LockOwner | null> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LockOwner>;
      return typeof data.pid === 'number' && typeof data.host === 'string' && typeof data.at === 'number' ? data as LockOwner : null;
    } catch { return null; }
  }

  private write() { return writeAtomic(this.file, JSON.stringify({ ...me(), at: Date.now() })); }

  /** Toma a trava (ou renova, se já é deste processo). Recusa se outro processo vivo a tem. */
  async acquire(): Promise<LockResult> {
    const owner = await this.owner();
    if (owner && lockHeld(owner)) return { ok: false, owner };
    await this.write();
    // Confere depois de gravar: dois processos que chegaram juntos não saem os dois com a trava.
    const after = await this.owner();
    if (after && (after.pid !== process.pid || after.host !== hostname())) return { ok: false, owner: after };
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.write().catch(() => undefined); }, LOCK_HEARTBEAT_MS);
    this.timer.unref();
    return { ok: true };
  }

  /** Solta a trava, se for deste processo. */
  async release() {
    clearInterval(this.timer);
    this.timer = undefined;
    const owner = await this.owner();
    if (owner && owner.pid === process.pid && owner.host === hostname()) await unlink(this.file).catch(() => undefined);
  }
}
