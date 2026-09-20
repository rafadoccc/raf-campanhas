// Called once per server-rendered page; LiveRefresh refreshes visible pages.
export async function readConnectionState() {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/whatsapp/status`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return 'unavailable';
    const data = await response.json();
    return data.state === 'connected' ? 'connected' : 'disconnected';
  } catch { return 'unavailable'; }
}
