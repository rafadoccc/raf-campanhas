type Environment = {
  visible: () => boolean;
  listen: (callback: () => void) => () => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (timer: number) => void;
};
export function connectionPollDelay(state?: string): number | null {
  return ['connecting', 'qr', 'reconnecting'].includes(state ?? '') ? 2500 : state === 'connected' ? 15000 : state === 'unavailable' ? 30000 : null;
}
export function startVisiblePolling(task: (signal: AbortSignal) => Promise<number | null>, env: Environment = {
  visible: () => document.visibilityState === 'visible',
  listen: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
  schedule: (callback, delay) => window.setTimeout(callback, delay), cancel: timer => window.clearTimeout(timer)
}) {
  let disposed = false; let generation = 0; let timer: number | undefined; let controller: AbortController | undefined;
  function cancel() { generation++; if (timer !== undefined) env.cancel(timer); timer = undefined; controller?.abort(); }
  async function run() {
    if (disposed || !env.visible()) return;
    const version = generation; controller = new AbortController();
    let delay: number | null = null;
    try { delay = await task(controller.signal); } catch { delay = 30000; }
    if (!disposed && version === generation && env.visible() && delay !== null) timer = env.schedule(() => { void run(); }, delay);
  }
  const unlisten = env.listen(() => { cancel(); if (env.visible()) void run(); });
  void run();
  return () => { disposed = true; cancel(); unlisten(); };
}
