import type { ReactNode } from 'react';

// Peças visuais compartilhadas pelas telas: mesmo selo, mesmo botão, mesmo formato de hora.

const TZ = 'America/Sao_Paulo';
export const hora = (at: string | Date) => new Date(at).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const horaSeg = (at: string | Date) => new Date(at).toLocaleTimeString('pt-BR', { timeZone: TZ, hourCycle: 'h23' });
export const dataHora = (at: string | Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
export const data = (at: string | Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(new Date(at));
export const membros = (n?: number | null) => (n == null ? null : `${n} ${n === 1 ? 'membro' : 'membros'}`);

export const page = 'mx-auto max-w-5xl p-6 md:p-10';
export const card = 'rounded-xl border border-slate-200 bg-white';
export const primaryButton = 'inline-flex items-center justify-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50';
export const secondaryButton = 'inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-40';

export function Pill({ tone, title, children }: { tone: string; title?: string; children: ReactNode }) {
  return <span title={title} className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>;
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">{title}</h1>{action}</header>;
}

export function LoadError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return <div role="alert" className="p-6 text-sm text-amber-800">Não foi possível carregar {what}. Confira se o sistema está ligado.{onRetry && <button type="button" onClick={onRetry} className="ml-2 underline">Tentar novamente</button>}</div>;
}

export const campaignStatus: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Rascunho', tone: 'bg-slate-100 text-slate-700' },
  ACTIVE: { label: 'Ativa', tone: 'bg-emerald-100 text-emerald-800' },
  PAUSED: { label: 'Pausada', tone: 'bg-amber-100 text-amber-800' },
  COMPLETED: { label: 'Concluída', tone: 'bg-sky-100 text-sky-800' },
  CANCELLED: { label: 'Encerrada', tone: 'bg-slate-100 text-slate-500' },
};

export type Wait = { expectedAt: string; lateMinutes: number; reason: string | null };
type DeliveryLike = { status: string; provider: string; deliveredAt?: string | null; serverRejectedAt?: string | null; attempts?: number; wait?: Wait | null };

// Situação de um envio (ADR-012/014). "Enviado" = o WhatsApp recebeu o pedido; "Entregue" exige
// o recibo de entrega de algum membro. Zero leituras não quer dizer que não chegou.
export function deliveryStatus(d: DeliveryLike): { label: string; tone: string; title?: string } {
  if (d.status === 'SENT' && d.provider === 'simulator') return { label: 'Simulado', tone: 'bg-slate-100 text-slate-600' };
  if (d.status === 'SENT' && d.deliveredAt) return { label: 'Entregue ✓✓', tone: 'bg-emerald-100 text-emerald-800', title: 'Recibo de entrega de pelo menos um membro' };
  if (d.status === 'SENT') return { label: 'Enviado ✓', tone: 'bg-emerald-50 text-emerald-700', title: 'O WhatsApp recebeu; aguardando recibo de entrega' };
  if (d.status === 'PROCESSING') return { label: 'Enviando', tone: 'bg-sky-100 text-sky-800' };
  if (d.status === 'PENDING' && (d.attempts ?? 0) > 0) return { label: 'Nova tentativa', tone: 'bg-amber-100 text-amber-800' };
  if (d.status === 'PENDING' && (d.wait?.lateMinutes ?? 0) > 0) return { label: 'Atrasado', tone: 'bg-amber-100 text-amber-800' };
  if (d.status === 'PENDING') return { label: 'Aguardando', tone: 'bg-slate-100 text-slate-700' };
  if (d.status === 'FAILED' && d.serverRejectedAt) return { label: 'Recusado', tone: 'bg-red-100 text-red-700', title: 'O WhatsApp recusou a mensagem' };
  if (d.status === 'FAILED') return { label: 'Falhou', tone: 'bg-red-100 text-red-700' };
  return { label: 'Cancelado', tone: 'bg-slate-100 text-slate-500' };
}
