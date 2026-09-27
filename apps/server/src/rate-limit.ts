// Limite geral de pedidos à API por IP (balde de fichas, em memória: um processo só).
// Folgado para o uso normal do painel — cada tela consulta poucas rotas a cada 15 s, e a lista
// de campanhas abre dezenas de miniaturas de uma vez —, mas corta um script que dispara pedidos
// sem parar e derrubaria uma VPS pequena. O login tem um limite próprio, bem mais estreito.
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  /** Teto de IPs em memória: pedidos de IPs sempre novos não crescem sem limite. */
  static readonly MAX_KEYS = 20_000;
  constructor(private capacity = 300, private refillPerSecond = 5, private now = () => Date.now()) {}
  get size() { return this.buckets.size; }

  /** true se o pedido pode seguir; false se estourou o limite. */
  take(key: string) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond);
      bucket.at = now;
      // Reinsere no fim: o Map fica em ordem de uso, e a poda descarta os parados há mais tempo.
      this.buckets.delete(key);
    } else {
      bucket = { tokens: this.capacity, at: now };
      if (this.buckets.size >= RateLimiter.MAX_KEYS) this.prune(now);
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Segundos até ter uma ficha de novo (para o cabeçalho Retry-After). */
  retryAfter(key: string) {
    const bucket = this.buckets.get(key);
    return bucket ? Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSecond)) : 1;
  }

  private prune(now: number) {
    // Balde cheio de novo = IP parado: não precisa ficar em memória.
    const full = (this.capacity / this.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) if (now - bucket.at >= full) this.buckets.delete(key);
    const target = Math.floor(RateLimiter.MAX_KEYS * 0.9);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(key);
    }
  }
}
