// Cliente único da API. Painel e API têm a mesma origem: o cookie de sessão vai sozinho
// e não há URL de API a configurar (a causa do antigo 404 ao gerar o QR).

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let onUnauthorized: (() => void) | undefined;
/** Chamado quando a sessão acaba no meio do uso: o painel volta para o login. */
export function setUnauthorizedHandler(handler: () => void) { onUnauthorized = handler; }

type Options = Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit };

export async function api<T>(path: string, { json, headers, ...init }: Options = {}): Promise<T> {
  const finalHeaders = new Headers(headers);
  let body = init.body;
  if (json !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, body, headers: finalHeaders, credentials: 'same-origin', cache: 'no-store' });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('Sem conexão com o servidor. Confira se o sistema está ligado.', 0);
  }
  const text = await response.text();
  let data: { error?: string } | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  if (response.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
  if (!response.ok) throw new ApiError(data?.error ?? `Falha na comunicação com o servidor (${response.status}).`, response.status);
  return data as T;
}

export const errorMessage = (error: unknown, fallback = 'Algo deu errado.') => error instanceof Error ? error.message : fallback;

/** Estado da conexão do WhatsApp usado nos avisos das telas. */
export async function connectionState(signal?: AbortSignal): Promise<'connected' | 'disconnected' | 'unavailable'> {
  return (await connectionSummary(signal)).state;
}

/** Aviso de pausa automática por sinal de restrição do WhatsApp (ADR-041). */
export type SafetyNotice = { reason: string; at: string | null };

/** Estado da conexão e, se houver, o aviso de pausa automática. */
export async function connectionSummary(signal?: AbortSignal): Promise<{ state: 'connected' | 'disconnected' | 'unavailable'; safety: SafetyNotice | null }> {
  try {
    const data = await api<{ state: string; safety?: SafetyNotice }>('/whatsapp/status', { signal });
    return { state: data.state === 'connected' ? 'connected' : 'disconnected', safety: data.safety ?? null };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { state: 'unavailable', safety: null };
  }
}
