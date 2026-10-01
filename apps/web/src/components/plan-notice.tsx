import { api } from '../lib/api';
import { usePolling } from '../lib/use-polling';
import { Badge, Card, IconAlert } from '../design';

// O plano da conta como o cliente vê (ADR-050): a faixa de aviso no topo do painel quando a
// assinatura está para vencer, venceu ou a conta foi pausada, e o cartão "Seu plano" em Minha conta.
// Quem define o plano é o administrador; aqui é só leitura.

type MyPlan = { plan: string | null; dueDate: string | null; daysLeft: number | null; state: 'active' | 'paused' | 'expired'; maxGroups: number | null; message: string | null; dueSoonDays: number };

const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
// Uma resposta guardada para as duas telas; confere de novo a cada 5 minutos.
const usePlan = () => usePolling(signal => api<MyPlan>('/plan', { signal }), [], 300_000, 'plano').data;

function dueText(plan: MyPlan) {
  if (plan.daysLeft === 0) return 'vence hoje';
  if (plan.daysLeft === 1) return 'vence amanhã';
  return `vence em ${plan.daysLeft} dias (${brDate(plan.dueDate!).slice(0, 5)})`;
}

/** Faixa no topo do painel. Não aparece enquanto está tudo em dia. */
export function PlanNotice() {
  const plan = usePlan();
  if (!plan) return null;
  const dueSoon = plan.state === 'active' && plan.daysLeft !== null && plan.daysLeft <= plan.dueSoonDays;
  if (!plan.message && !dueSoon) return null;
  const blocked = Boolean(plan.message);
  return <div role={blocked ? 'alert' : 'status'} className={`flex shrink-0 animate-fade-in items-start justify-center gap-2 border-b px-4 py-2 text-xs ${blocked ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
    <IconAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
    <span>{plan.message ?? `Sua assinatura ${dueText(plan)}. Fale com o administrador para renovar e não parar os envios.`}</span>
  </div>;
}

/** Cartão "Seu plano" em Minha conta. Sem plano definido pelo administrador, não aparece. */
export function PlanCard() {
  const plan = usePlan();
  if (!plan || (!plan.plan && !plan.dueDate && plan.maxGroups === null && plan.state === 'active')) return null;
  const status = plan.state === 'paused' ? { label: 'Pausada', tone: 'warning' as const } : plan.state === 'expired' ? { label: 'Vencida', tone: 'danger' as const } : { label: 'Ativa', tone: 'brand' as const };
  const rows: [string, string][] = [
    ['Plano', plan.plan ?? 'Sem nome'],
    ['Pago até', plan.dueDate ? brDate(plan.dueDate) : 'Sem vencimento'],
    ['Grupos por campanha', plan.maxGroups === null ? 'Sem limite' : `Até ${plan.maxGroups}`],
  ];
  return <Card as="div" className="space-y-3 p-5">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">Seu plano</h2>
      <Badge tone={status.tone}>{status.label}</Badge>
    </div>
    <dl className="divide-y divide-line text-sm">
      {rows.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-3 py-2">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className="tabular font-medium">{value}</dd>
      </div>)}
    </dl>
    {plan.message && <p className="text-xs text-red-800">{plan.message}</p>}
    <p className="text-2xs text-slate-400">Quem altera o plano é o administrador do sistema.</p>
  </Card>;
}
