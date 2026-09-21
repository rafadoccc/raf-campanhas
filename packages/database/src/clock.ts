import { performance } from 'node:perf_hooks';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const TIME_ZONE = 'America/Sao_Paulo';
type Calibration = { offset: number; verifiedAt: number };
type Cache = { load(): Promise<Calibration | undefined>; save(value: Calibration): Promise<void> };
const sources = ['https://www.google.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace'];

export class ReferenceClock {
  private anchor?: { epoch: number; tick: number };
  private pending?: Promise<void>;
  private attempted = -Infinity;
  private loaded = false;
  private source = 'server';
  constructor(private request: typeof fetch = (...args) => fetch(...args), private tick = () => performance.now(), private wall = () => Date.now(), private cache?: Cache) {}
  status() { return { source: this.source, synchronized: this.source !== 'server' }; }
  private async synchronize() {
    const samples = await Promise.all(sources.map(async url => {
      const start = this.tick();
      const response = await this.request(`${url}?clock=${randomUUID()}`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const end = this.tick(); const epoch = Date.parse(response.headers.get('date') ?? '');
      const age = Number(response.headers.get('age') ?? 0);
      await response.body?.cancel();
      if (!response.ok || !Number.isFinite(epoch) || age !== 0 || end - start > 3000) throw Error('Invalid time reference');
      return { epoch: epoch + (end - start) / 2, tick: end };
    }));
    const tick = this.tick(); const epochs = samples.map(s => s.epoch + tick - s.tick);
    if (Math.abs(epochs[0] - epochs[1]) > 5000) throw Error('Conflicting time references');
    const epoch = Math.round((epochs[0] + epochs[1]) / 2);
    this.anchor = { epoch, tick }; this.source = 'network';
    await this.cache?.save({ offset: epoch - this.wall(), verifiedAt: epoch }).catch(() => {});
  }
  async now(): Promise<Date> {
    if (!this.pending && this.tick() - this.attempted > 300000) {
      this.attempted = this.tick();
      this.pending = (async () => {
        if (!this.loaded) {
          this.loaded = true;
          const saved = await this.cache?.load().catch(() => undefined);
          if (saved && Number.isFinite(saved.offset) && Number.isFinite(saved.verifiedAt)) {
            this.anchor = { epoch: this.wall() + saved.offset, tick: this.tick() }; this.source = 'cache';
          }
        }
        await this.synchronize();
      })().catch(() => {}).finally(() => { this.pending = undefined; });
    }
    // Only the initial calibration waits (bounded). Refreshes never hold up
    // pausing/stopping or the queue. A trusted sample keeps advancing offline.
    if (!this.anchor) await this.pending;
    this.anchor ??= { epoch: this.wall(), tick: this.tick() };
    return new Date(this.anchor.epoch + this.tick() - this.anchor.tick);
  }
}

const cacheFile = path.resolve(process.cwd(), '.runtime/clock.json');
const cache: Cache = {
  async load() { return JSON.parse(await readFile(cacheFile, 'utf8')); },
  async save(value) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, cacheFile);
  }
};
const clock = new ReferenceClock(undefined, undefined, undefined, process.env.CAMPAIGN_TEST_DATABASE ? undefined : cache);
export const currentTime = () => clock.now();
export const clockStatus = () => clock.status();
