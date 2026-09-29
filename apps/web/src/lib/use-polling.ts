import { useEffect, useState } from 'react';
import { startVisiblePolling } from './visible-polling';
import { errorMessage } from './api';
import { screenCache } from './cache';

// Carrega dados e atualiza a cada `intervalMs` só com a aba visível (substitui o
// "LiveRefresh" do Next). A PRIMEIRA carga acontece sempre, mesmo com a aba em segundo
// plano: no Next ela vinha pronta do servidor, e uma aba aberta atrás não pode ficar
// vazia. reload() recarrega na hora, por exemplo após uma ação.
// Com `cacheKey`, a tela abre com a última resposta guardada (troca de tela instantânea) e
// atualiza por trás; a chave identifica o dado (ex.: `campanha:<id>`).
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], intervalMs = 15_000, cacheKey?: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>(() => ({ data: screenCache.get<T>(cacheKey) ?? null, error: null, loading: true }));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const generation = screenCache.generation();
    // Com chave, o dado anterior só continua na tela se for do mesmo recurso (outra campanha não).
    setState(current => ({ ...current, data: cacheKey ? screenCache.get<T>(cacheKey) ?? null : current.data, loading: true }));
    let first = true;
    return startVisiblePolling(async signal => {
      try {
        const data = await load(signal);
        if (!signal.aborted && screenCache.generation() === generation) {
          screenCache.setIfCurrent(cacheKey, data, generation);
          setState({ data, error: null, loading: false });
        }
      } catch (error) {
        if (!signal.aborted && screenCache.generation() === generation) setState(current => ({ data: current.data, error: errorMessage(error), loading: false }));
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
  }, [...deps, version, cacheKey]);
  return { ...state, reload: () => setVersion(v => v + 1) };
}
