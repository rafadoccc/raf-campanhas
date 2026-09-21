import { useEffect, useState } from 'react';
import { startVisiblePolling } from './visible-polling';
import { errorMessage } from './api';

// Carrega dados e atualiza a cada `intervalMs` só com a aba visível (substitui o
// "LiveRefresh" do Next). A PRIMEIRA carga acontece sempre, mesmo com a aba em segundo
// plano: no Next ela vinha pronta do servidor, e uma aba aberta atrás não pode ficar
// vazia. reload() recarrega na hora, por exemplo após uma ação.
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], intervalMs = 15_000) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setState(current => ({ ...current, loading: true }));
    let first = true;
    return startVisiblePolling(async signal => {
      try {
        const data = await load(signal);
        if (!signal.aborted) setState({ data, error: null, loading: false });
      } catch (error) {
        if (!signal.aborted) setState(current => ({ data: current.data, error: errorMessage(error), loading: false }));
      }
      return intervalMs;
    }, {
      visible: () => {
        if (first) { first = false; return true; }
        return document.visibilityState === 'visible';
      },
      listen: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: timer => window.clearTimeout(timer),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { ...state, reload: () => setVersion(v => v + 1) };
}
