import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/api';

// Rolagem infinita (ADR-026). Carrega a próxima página quando o fim da lista aparece dentro
// da área de rolagem (IntersectionObserver): nada de botão "ver mais" nem de carregar tudo.
// A primeira página é atualizada periodicamente (aba visível) e mesclada por id, sem perder o
// que já foi carregado nem voltar a rolagem para o topo.

export type PageResult<T> = { items: T[]; next: string | null };

export function useInfiniteList<T extends { id: string }>(
  loadPage: (cursor: string | null, signal: AbortSignal) => Promise<PageResult<T>>,
  deps: unknown[],
  refreshMs = 15_000,
) {
  const [items, setItems] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;

  // Primeira página: ao montar, quando as dependências mudam e a cada `refreshMs`.
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let first = true;
    const run = async () => {
      // Aba escondida: não consulta; tenta de novo no próximo intervalo.
      if (!first && document.visibilityState !== 'visible') { timer = window.setTimeout(run, refreshMs); return; }
      try {
        const page = await loadRef.current(null, controller.signal);
        if (controller.signal.aborted) return;
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
        if (!controller.signal.aborted) setError(errorMessage(e));
      }
      if (!controller.signal.aborted && refreshMs > 0) timer = window.setTimeout(run, refreshMs);
    };
    setItems(null);
    void run();
    return () => { controller.abort(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, refreshMs]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadRef.current(next, new AbortController().signal);
      setItems(current => {
        const known = new Set((current ?? []).map(item => item.id));
        return [...(current ?? []), ...page.items.filter(item => !known.has(item.id))];
      });
      setNext(page.next);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoadingMore(false); }
  }, [next, loadingMore]);

  /** Remove da lista local (ex.: depois de excluir), sem recarregar tudo. */
  const remove = useCallback((id: string) => setItems(current => current?.filter(item => item.id !== id) ?? current), []);

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
    const root = node.closest('.scroll-area');
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) callback.current(); }, { root, rootMargin: '400px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  return <div ref={ref} aria-hidden className="h-px" />;
}
