import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/api';
import { screenCache } from '../lib/cache';

// Rolagem infinita (ADR-026). Carrega a próxima página quando o fim da lista aparece dentro
// da área de rolagem (IntersectionObserver): nada de botão "ver mais" nem de carregar tudo.
// A primeira página é atualizada periodicamente (aba visível) e mesclada por id, sem perder o
// que já foi carregado nem voltar a rolagem para o topo. Com `cacheKey`, a lista reabre na hora
// com a primeira página da última visita e atualiza por trás (ver lib/cache.ts).

export type PageResult<T> = { items: T[]; next: string | null };

export function useInfiniteList<T extends { id: string }>(
  loadPage: (cursor: string | null, signal: AbortSignal) => Promise<PageResult<T>>,
  deps: unknown[],
  refreshMs = 15_000,
  cacheKey?: string,
) {
  const [items, setItems] = useState<T[] | null>(() => screenCache.get<PageResult<T>>(cacheKey)?.items ?? null);
  const [next, setNext] = useState<string | null>(() => screenCache.get<PageResult<T>>(cacheKey)?.next ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(loadPage);
  const listGeneration = useRef(0);
  loadRef.current = loadPage;

  // Primeira página: ao montar, quando as dependências mudam e a cada `refreshMs`.
  useEffect(() => {
    const generation = screenCache.generation();
    const requestGeneration = ++listGeneration.current;
    const controller = new AbortController();
    let timer: number | undefined;
    let first = true;
    const run = async () => {
      // Aba escondida: não consulta; tenta de novo no próximo intervalo.
      if (!first && document.visibilityState !== 'visible') { timer = window.setTimeout(run, refreshMs); return; }
      try {
        const page = await loadRef.current(null, controller.signal);
        if (controller.signal.aborted || screenCache.generation() !== generation || listGeneration.current !== requestGeneration) return;
        screenCache.setIfCurrent(cacheKey, page, generation);
        setError(null);
        if (first) {
          setItems(page.items);
          setNext(page.next);
        } else {
          // Mescla: itens atualizados no lugar, novos no topo, o resto preservado.
          setItems(current => {
            if (!current) return page.items;
            const fresh = new Map(page.items.map(item => [item.id, item]));
            const known = new Set(current.map(item => item.id));
            return [...page.items.filter(item => !known.has(item.id)), ...current.map(item => fresh.get(item.id) ?? item)];
          });
        }
        first = false;
      } catch (e) {
        if (!controller.signal.aborted && screenCache.generation() === generation && listGeneration.current === requestGeneration) setError(errorMessage(e));
      }
      if (!controller.signal.aborted && refreshMs > 0) timer = window.setTimeout(run, refreshMs);
    };
    const cached = screenCache.get<PageResult<T>>(cacheKey);
    setItems(cached?.items ?? null);
    setNext(cached?.next ?? null);
    setLoadingMore(false);
    void run();
    return () => { listGeneration.current++; controller.abort(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, refreshMs, cacheKey]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    const generation = screenCache.generation();
    const requestGeneration = listGeneration.current;
    setLoadingMore(true);
    try {
      const page = await loadRef.current(next, new AbortController().signal);
      if (screenCache.generation() !== generation || listGeneration.current !== requestGeneration) return;
      setItems(current => {
        const known = new Set((current ?? []).map(item => item.id));
        return [...(current ?? []), ...page.items.filter(item => !known.has(item.id))];
      });
      setNext(page.next);
    } catch (e) { if (screenCache.generation() === generation && listGeneration.current === requestGeneration) setError(errorMessage(e)); }
    finally { if (screenCache.generation() === generation && listGeneration.current === requestGeneration) setLoadingMore(false); }
  }, [next, loadingMore]);

  /** Remove da lista local (ex.: depois de excluir), sem recarregar tudo. */
  const remove = useCallback((id: string) => {
    setItems(current => current?.filter(item => item.id !== id) ?? current);
    const cached = screenCache.get<PageResult<T>>(cacheKey);
    if (cached) screenCache.set(cacheKey, { ...cached, items: cached.items.filter(item => item.id !== id) });
  }, [cacheKey]);

  return { items, error, hasMore: Boolean(next), loadingMore, loadMore, reload: () => setVersion(v => v + 1), remove };
}

/** Marcador no fim da lista: quando entra na tela, pede a próxima página. */
export function LoadMoreSentinel({ onVisible, active }: { onVisible: () => void; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    // A área que DE FATO rola: no desktop, a lista; no celular a lista cresce e quem rola é a
    // página inteira. Nenhuma rolando ainda (poucos itens): a própria tela.
    let root: Element | null = node.closest('.scroll-area');
    while (root && root.scrollHeight <= root.clientHeight + 1) root = root.parentElement?.closest('.scroll-area') ?? null;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) callback.current(); }, { root, rootMargin: '400px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  return <div ref={ref} aria-hidden className="h-px" />;
}
