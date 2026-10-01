import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { NumberProtection } from './number-protection';
import { Alert, Badge, Button, Checkbox, Field, IconButton, IconCheck, IconRemove, Skeleton, inputClass, type Tone } from '../design';

// Plano e regras de uma conta (ADR-050), só para o administrador. O plano diz até quando a conta
// pode enviar, se está pausada e quantos grupos cabem numa campanha; a cobrança acontece fora do
// sistema. As regras de envio (ADR-041) ficam logo abaixo, na mesma janela.

export type PlanState = 'active' | 'paused' | 'expired';
export type PlanSummary = { plan: string | null; priceCents: number | null; dueDate: string | null; paused: boolean; maxGroups: number | null; state: PlanState };
type Plan = PlanSummary & { limits: { maxGroups: { min: number; max: number } } };

const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Dia de hoje no calendário de São Paulo (o vencimento é uma data de lá). */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
/** Mesma data no mês seguinte; dia que não existe (31 em mês de 30) vira o último dia do mês. */
function nextMonth(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
const toMoney = (cents: number | null) => (cents === null ? '' : (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** "147", "147,5" ou "1.250,00" em centavos; vazio = sem valor; texto inválido = NaN. */
function toCents(text: string) {
  const clean = text.trim().replace(/^R\$\s*/i, '');
  if (!clean) return null;
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(clean)) return NaN;
  return Math.round(Number(clean.replace(/\./g, '').replace(',', '.')) * 100);
}

/** Selo do plano na lista de contas: vencida, pausada, vence em breve ou a data do vencimento. */
export function planBadge(plan: PlanSummary | null): { label: string; tone: Tone; title?: string } | null {
  if (!plan) return null;
  if (plan.state === 'paused') return { label: 'Pausada', tone: 'warning', title: 'Conta pausada: guarda tudo, mas não envia.' };
  if (plan.state === 'expired') return { label: `Vencida em ${brDate(plan.dueDate!).slice(0, 5)}`, tone: 'danger', title: 'Assinatura vencida: a conta não envia até você renovar.' };
  if (!plan.dueDate) return plan.plan ? { label: plan.plan, tone: 'neutral', title: 'Sem vencimento definido.' } : null;
  const left = daysBetween(today(), plan.dueDate);
  const when = left === 0 ? 'Vence hoje' : left === 1 ? 'Vence amanhã' : `Vence em ${brDate(plan.dueDate).slice(0, 5)}`;
  return { label: when, tone: left <= 5 ? 'warning' : 'neutral', title: plan.plan ?? undefined };
}

function PlanForm({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [name, setName] = useState(''); const [price, setPrice] = useState('');
  const [dueDate, setDueDate] = useState(''); const [paused, setPaused] = useState(false);
  const [maxGroups, setMaxGroups] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  function load(data: Plan) {
    setPlan(data); setName(data.plan ?? ''); setPrice(toMoney(data.priceCents));
    setDueDate(data.dueDate ?? ''); setPaused(data.paused); setMaxGroups(data.maxGroups);
  }
  useEffect(() => { api<Plan>(`/admin/users/${userId}/plan`).then(load).catch(e => setError(errorMessage(e))); }, [userId]);
  if (!plan) return error ? <Alert>{error}</Alert> : <Skeleton className="h-40" />;

  const { min, max } = plan.limits.maxGroups;
  const cents = toCents(price);
  const edit = (change: () => void) => { change(); setNotice(''); setError(''); };
  const changed = name.trim() !== (plan.plan ?? '') || cents !== plan.priceCents || dueDate !== (plan.dueDate ?? '') || paused !== plan.paused || maxGroups !== plan.maxGroups;
  const invalid = Number.isNaN(cents) || (maxGroups !== null && (maxGroups < min || maxGroups > max));
  // Como a conta fica se salvar agora.
  const left = dueDate ? daysBetween(today(), dueDate) : null;
  const preview: { label: string; tone: Tone } = paused ? { label: 'Pausada: não envia', tone: 'warning' }
    : left !== null && left < 0 ? { label: 'Vencida: não envia', tone: 'danger' }
      : { label: left === null ? 'Ativa, sem vencimento' : left === 0 ? 'Ativa, vence hoje' : `Ativa por mais ${left} ${left === 1 ? 'dia' : 'dias'}`, tone: 'brand' };

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api<Plan & { pausedCampaigns: number }>(`/admin/users/${userId}/plan`, { method: 'PUT', json: { plan: name.trim() || null, priceCents: cents, dueDate: dueDate || null, paused, maxGroups } });
      load(saved);
      setNotice(saved.pausedCampaigns ? `Salvo. ${saved.pausedCampaigns} ${saved.pausedCampaigns === 1 ? 'campanha ativa foi pausada' : 'campanhas ativas foram pausadas'}.` : 'Salvo');
      onSaved();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return <section className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Plano</h3>
        <p className="text-xs text-muted">A cobrança é feita por fora (Pix ou link de pagamento). Aqui você registra até quando a conta está paga. Vencida ou pausada, a conta continua entrando e vendo tudo, mas não envia.</p>
      </div>
      <Badge tone={preview.tone}>{preview.label}</Badge>
    </div>
    {error && <Alert>{error}</Alert>}
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Nome do plano" hint="Só para o seu controle e para o cliente ver em Minha conta.">
        <input value={name} maxLength={40} onChange={e => edit(() => setName(e.target.value))} placeholder="Ex.: Mensal" className={inputClass} />
      </Field>
      <Field label="Valor por mês (R$)" hint={Number.isNaN(cents) ? 'Use o formato 147,00.' : 'Só você vê este valor.'}>
        <input value={price} inputMode="decimal" onChange={e => edit(() => setPrice(e.target.value))} placeholder="147,00" aria-invalid={Number.isNaN(cents)} className={inputClass} />
      </Field>
    </div>
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted">Pago até</span>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" aria-label="Pago até" value={dueDate} onChange={e => edit(() => setDueDate(e.target.value))} className={`${inputClass} !w-44`} />
        {/* Renovar conta a partir do que for mais tarde: o vencimento atual ou hoje. */}
        <Button size="sm" onClick={() => edit(() => setDueDate(nextMonth(dueDate && dueDate > today() ? dueDate : today())))}>+1 mês</Button>
        {dueDate && <Button size="sm" variant="ghost" onClick={() => edit(() => setDueDate(''))}>Sem vencimento</Button>}
      </div>
      <span className="block text-2xs text-slate-400">A conta envia até o fim deste dia. No dia seguinte, as campanhas ativas são pausadas sozinhas.</span>
    </div>
    <div className="space-y-2">
      <Checkbox checked={maxGroups !== null} onChange={on => edit(() => setMaxGroups(on ? 50 : null))} label="Limitar os grupos por campanha" hint="Uma campanha com mais grupos do que isto não é criada nem iniciada." />
      {maxGroups !== null && <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
        <input type="number" inputMode="numeric" min={min} max={max} aria-label="Grupos por campanha" value={maxGroups || ''} onChange={e => edit(() => setMaxGroups(Number(e.target.value)))} className={`${inputClass} !w-28`} />
        grupos por campanha
      </div>}
    </div>
    <Checkbox checked={paused} onChange={value => edit(() => setPaused(value))} label="Conta pausada" hint="Para o mês em que o cliente não vai usar: guarda grupos, modelos, listas e o número conectado, mas não envia. Desmarque para reativar." />
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" loading={busy} disabled={busy || !changed || invalid} onClick={() => void save()}>Salvar plano</Button>
      {notice && !changed && <span className="inline-flex items-center gap-1 text-xs text-brand-700"><IconCheck className="h-3.5 w-3.5" aria-hidden />{notice}</span>}
    </div>
  </section>;
}

/** Janela "Plano e regras" de uma conta. Administrador não tem plano: só as regras aparecem. */
export function AccountPlanDialog({ user, onClose, onSaved }: { user: { id: string; name: string; role: string }; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  // A lista de contas se atualiza sozinha e recria onClose a cada vez: o foco só é levado para a
  // janela ao ABRIR (senão sairia do campo que a pessoa está preenchendo).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  const client = user.role !== 'SUPER_ADMIN';

  return <div className="fixed inset-0 z-50 flex animate-overlay-in items-center justify-center bg-ink/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="plan-title" className="flex max-h-full w-full max-w-2xl animate-pop-in flex-col rounded-lg border border-line bg-white shadow-pop outline-none">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted">{client ? 'Plano e regras' : 'Regras de envio'}</p>
          <h2 id="plan-title" className="truncate text-base font-semibold leading-tight">{user.name}</h2>
        </div>
        <IconButton icon={IconRemove} label="Fechar" onClick={onClose} />
      </header>
      <div className="scroll-area min-h-0 space-y-6 overflow-y-auto p-5">
        {client && <PlanForm userId={user.id} onSaved={onSaved} />}
        <div className={client ? 'border-t border-line pt-6' : ''}><NumberProtection userId={user.id} /></div>
      </div>
    </div>
  </div>;
}
