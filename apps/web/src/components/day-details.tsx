import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { Alert, IconButton, IconRemove, Skeleton, Stat, IconDelivered, IconReach, IconReads, IconSent, numero } from '../design';

// Números de um dia (ADR-045), abertos ao clicar numa barra do gráfico do Início: o mesmo resumo
// do topo do Início, mas daquele dia, com os envios por hora e por campanha.

type Day = {
  day: string; sent: number; delivered: number; failed: number; reads: number;
  deliveryRate: number | null; groupsReached: number; membersReached: number;
  campaigns: { id: string; name: string; sent: number; delivered: number }[];
  hours: { hour: number; sent: number }[];
};

const longDay = (iso: string) => {
  const text = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function DayDetails({ day, onClose }: { day: string; onClose: () => void }) {
  const [data, setData] = useState<Day | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setData(null); setError('');
    const controller = new AbortController();
    api<Day>(`/dashboard/day?date=${encodeURIComponent(day)}`, { signal: controller.signal }).then(setData)
      .catch(e => { if ((e as Error).name !== 'AbortError') setError(errorMessage(e)); });
    return () => controller.abort();
  }, [day]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);

  const peak = Math.max(1, ...(data?.hours.map(h => h.sent) ?? [1]));
  return <div className="fixed inset-0 z-50 flex animate-overlay-in items-center justify-center bg-ink/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="day-title" className="flex max-h-full w-full max-w-lg animate-pop-in flex-col rounded-lg border border-line bg-white shadow-pop outline-none">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="text-2xs font-medium uppercase tracking-wide text-muted">Resumo do dia</p>
          <h2 id="day-title" className="text-base font-semibold leading-tight">{longDay(day)}</h2>
        </div>
        <IconButton icon={IconRemove} label="Fechar" onClick={onClose} />
      </header>
      <div className="scroll-area min-h-0 space-y-5 overflow-y-auto p-5">
        {error && <Alert>{error}</Alert>}
        {!data && !error && <><Skeleton className="h-16" /><Skeleton className="h-24" /></>}
        {data && <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat icon={IconSent} label="Enviados" value={numero(data.sent)} hint={data.failed ? `${data.failed} com falha` : 'sem falhas'} />
            <Stat icon={IconDelivered} label="Entregues" value={numero(data.delivered)} hint={data.deliveryRate === null ? undefined : `${data.deliveryRate}% dos enviados`} tone="text-brand-700" />
            <Stat icon={IconReads} label="Visualizações" value={numero(data.reads)} />
            <Stat icon={IconReach} label="Alcance" value={numero(data.membersReached)} hint={`membros em ${data.groupsReached} ${data.groupsReached === 1 ? 'grupo' : 'grupos'}`} />
          </div>
          {data.sent === 0
            ? <p className="rounded bg-slate-50 px-3 py-4 text-center text-sm text-muted">Nenhum envio saiu neste dia.</p>
            : <>
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted">Envios por hora</h3>
                <div className="flex h-20 items-end gap-px" role="img" aria-label={`Envios por hora: ${data.hours.filter(h => h.sent).map(h => `${h.hour}h ${h.sent}`).join(', ')}`}>
                  {data.hours.map(h => <div key={h.hour} title={`${String(h.hour).padStart(2, '0')}h: ${h.sent} ${h.sent === 1 ? 'envio' : 'envios'}`} className="flex min-w-0 flex-1 flex-col justify-end">
                    <div className={`rounded-sm ${h.sent ? 'bg-brand-500' : 'bg-slate-100'}`} style={{ height: `${h.sent ? Math.max(4, (h.sent / peak) * 64) : 2}px` }} />
                  </div>)}
                </div>
                <div className="tabular flex justify-between text-2xs text-slate-400"><span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span></div>
              </section>
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted">Por campanha</h3>
                <ul className="divide-y divide-line rounded border border-line">
                  {data.campaigns.map(c => <li key={c.id}>
                    <Link to={`/campanhas/${c.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                      <span className="min-w-0 truncate font-medium">{c.name}</span>
                      <span className="tabular shrink-0 text-xs text-muted">{numero(c.sent)} {c.sent === 1 ? 'envio' : 'envios'} · {numero(c.delivered)} entregues</span>
                    </Link>
                  </li>)}
                </ul>
              </section>
            </>}
        </>}
      </div>
    </div>
  </div>;
}
