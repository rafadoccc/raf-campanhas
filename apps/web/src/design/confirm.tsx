import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './primitives';

// Confirmação em diálogo próprio (em vez do confirm() do navegador): mesmo visual em todo o
// sistema, foco no botão seguro e Esc para cancelar.
//   const confirm = useConfirm();
//   if (await confirm({ title: 'Excluir?', confirmLabel: 'Excluir', danger: true })) ...

type Options = { title: string; description?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
type Pending = Options & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((options: Options) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirm = useCallback((options: Options) => new Promise<boolean>(resolve => setPending({ ...options, resolve })), []);
  const close = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  return <ConfirmContext.Provider value={confirm}>
    {children}
    {pending && <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(false); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-sm rounded-lg border border-line bg-white p-5 shadow-pop">
        <h2 id="confirm-title" className="text-base font-semibold">{pending.title}</h2>
        {pending.description && <div className="mt-2 text-sm text-muted">{pending.description}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} onClick={() => close(false)}>{pending.cancelLabel ?? 'Cancelar'}</Button>
          <Button variant={pending.danger ? 'secondary' : 'primary'} className={pending.danger ? '!border-red-200 !bg-red-600 !text-white hover:!bg-red-700' : ''} onClick={() => close(true)}>{pending.confirmLabel ?? 'Confirmar'}</Button>
        </div>
      </div>
    </div>}
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm fora do ConfirmProvider');
  return confirm;
}
