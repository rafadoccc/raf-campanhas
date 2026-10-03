import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import type { Warmup } from './number-protection';
import { Alert, Badge, Button, Checkbox, Dot, Field, IconButton, IconCampaigns, IconCheck, IconPlan, IconRemove, IconSent, IconWhatsApp, Select, Skeleton, inputClass, numero, type Icon, type Tone } from '../design';

// Parâmetros de uma conta (ADR-050, ADR-054), só para o administrador. Uma janela com seções na
// lateral: Plano (até quando a conta está paga e se está pausada), Campanhas (quantas campanhas e
// quantos grupos por campanha), Envios (regras que protegem o número, ADR-041) e WhatsApp (pausa
// automática e situação do número). Um botão Salvar para tudo o que mudou.
// A cobrança acontece fora do sistema; aqui fica só o resultado dela.

export type PlanState = 'active' | 'paused' | 'expired';
export type PlanSummary = { plan: string | null; priceCents: number | null; dueDate: string | null; paused: boolean; maxGroups: number | null; state: PlanState };
type Range = { min: number; max: number };
type Plan = PlanSummary & { maxCampaigns: number; maxCampaignsIsDefault: boolean; limits: { maxGroups: Range; maxCampaigns: Range } };
type Rules = { quiet: { enabled: boolean; start: string; end: string }; dailyLimit: number | null; groupGapMinutes: number | null; autoPause: boolean };
type Policy = Rules & { defaults: Rules; limits: { dailyLimit: Range }; today: number | null; todayLimit: number | null; warmup: Warmup | null };
type Target = { id: string; name: string; role: string; whatsapp?: { state: string; accountJid: string | null } };

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
const GAPS = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const gapLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`) + (minutes === 120 ? ' (recomendado)' : '');
const pickRules = ({ quiet, dailyLimit, groupGapMinutes, autoPause }: Rules): Rules => ({ quiet, dailyLimit, groupGapMinutes, autoPause });
const short = `${inputClass.replace('block w-full', 'inline-block')} w-28`;
const connectionLabel: Record<string, string> = { connected: 'Conectado', qr: 'Aguardando QR', connecting: 'Conectando', reconnecting: 'Reconectando', error: 'Com erro', disconnected: 'Desconectado' };

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

type SectionId = 'plano' | 'campanhas' | 'envios' | 'whatsapp';
const SECTIONS: { id: SectionId; label: string; icon: Icon; clientOnly?: boolean }[] = [
  { id: 'plano', label: 'Plano', icon: IconPlan, clientOnly: true },
  { id: 'campanhas', label: 'Campanhas', icon: IconCampaigns, clientOnly: true },
  { id: 'envios', label: 'Envios', icon: IconSent },
  { id: 'whatsapp', label: 'WhatsApp', icon: IconWhatsApp },
];

/** Título e uma linha de explicação no alto de cada seção. */
function Heading({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-2">
    <div className="space-y-0.5"><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-muted">{children}</p></div>
    {aside}
  </div>;
}

/** Um número com rótulo ao lado, na mesma linha. */
function NumberRow({ value, onChange, range, label, unit }: { value: number; onChange: (value: number) => void; range: Range; label: string; unit: string }) {
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <input type="number" inputMode="numeric" min={range.min} max={range.max} aria-label={label} value={value || ''} onChange={e => onChange(Number(e.target.value))} className={short} />
    {unit}
  </div>;
}

/** Janela "Parâmetros" de uma conta. Administrador não tem plano nem limite: só Envios e WhatsApp. */
export function AccountPlanDialog({ user, onClose, onSaved }: { user: Target; onClose: () => void; onSaved: () => void }) {
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
  const sections = SECTIONS.filter(section => client || !section.clientOnly);
  const [section, setSection] = useState<SectionId>(sections[0].id);

  // O que está salvo e o que está sendo editado, para o plano e para as regras.
  const [plan, setPlan] = useState<Plan | null>(null);
  const [name, setName] = useState(''); const [price, setPrice] = useState('');
  const [dueDate, setDueDate] = useState(''); const [paused, setPaused] = useState(false);
  const [maxGroups, setMaxGroups] = useState<number | null>(null);
  const [maxCampaigns, setMaxCampaigns] = useState(8);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');

  function loadPlan(data: Plan) {
    setPlan(data); setName(data.plan ?? ''); setPrice(toMoney(data.priceCents));
    setDueDate(data.dueDate ?? ''); setPaused(data.paused); setMaxGroups(data.maxGroups); setMaxCampaigns(data.maxCampaigns);
  }
  useEffect(() => {
    if (client) api<Plan>(`/admin/users/${user.id}/plan`).then(loadPlan).catch(e => setError(errorMessage(e)));
    api<Policy>(`/admin/users/${user.id}/sending-policy`).then(data => { setPolicy(data); setRules(pickRules(data)); }).catch(e => setError(errorMessage(e)));
  }, [user.id, client]);

  const edit = (change: () => void) => { change(); setNotice(''); setError(''); };
  const setRule = (patch: Partial<Rules>) => edit(() => setRules(current => (current ? { ...current, ...patch } : current)));
  const cents = toCents(price);
  const planChanged = Boolean(plan) && (name.trim() !== (plan!.plan ?? '') || cents !== plan!.priceCents || dueDate !== (plan!.dueDate ?? '') || paused !== plan!.paused || maxGroups !== plan!.maxGroups || maxCampaigns !== plan!.maxCampaigns);
  const rulesChanged = Boolean(policy && rules) && JSON.stringify(rules) !== JSON.stringify(pickRules(policy!));
  const outside = (value: number, range: Range) => value < range.min || value > range.max;
  const invalid = Number.isNaN(cents)
    || (plan ? (maxGroups !== null && outside(maxGroups, plan.limits.maxGroups)) || outside(maxCampaigns, plan.limits.maxCampaigns) : false)
    || (policy && rules ? rules.dailyLimit !== null && outside(rules.dailyLimit, policy.limits.dailyLimit) : false);
  const loading = (client && !plan) || !policy || !rules;

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      let pausedCampaigns = 0;
      if (planChanged) {
        const saved = await api<Plan & { pausedCampaigns: number }>(`/admin/users/${user.id}/plan`, { method: 'PUT', json: { plan: name.trim() || null, priceCents: cents, dueDate: dueDate || null, paused, maxGroups, maxCampaigns } });
        loadPlan(saved); pausedCampaigns = saved.pausedCampaigns;
      }
      if (rulesChanged && rules) {
        const stored = await api<Rules>(`/admin/users/${user.id}/sending-policy`, { method: 'PUT', json: rules });
        setPolicy(current => (current ? { ...current, ...stored } : current)); setRules(pickRules(stored));
      }
      setNotice(pausedCampaigns ? `Salvo. ${pausedCampaigns} ${pausedCampaigns === 1 ? 'campanha ativa foi pausada' : 'campanhas ativas foram pausadas'}.` : 'Salvo');
      onSaved();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  // Como a conta fica se salvar agora.
  const left = dueDate ? daysBetween(today(), dueDate) : null;
  const preview: { label: string; tone: Tone } = paused ? { label: 'Pausada: não envia', tone: 'warning' }
    : left !== null && left < 0 ? { label: 'Vencida: não envia', tone: 'danger' }
      : { label: left === null ? 'Ativa, sem vencimento' : left === 0 ? 'Ativa, vence hoje' : `Ativa por mais ${left} ${left === 1 ? 'dia' : 'dias'}`, tone: 'brand' };
  const time = (value: string, onChange: (v: string) => void, label: string) =>
    <input type="time" aria-label={label} value={value} disabled={!rules?.quiet.enabled} onChange={e => onChange(e.target.value)} className={short} />;
  const wa = user.whatsapp;

  return <div className="fixed inset-0 z-50 flex animate-overlay-in items-center justify-center bg-ink/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="params-title" className="flex max-h-full w-full max-w-3xl animate-pop-in flex-col rounded-lg border border-line bg-white shadow-pop outline-none">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted">Parâmetros da conta</p>
          <h2 id="params-title" className="truncate text-base font-semibold leading-tight">{user.name}</h2>
        </div>
        <IconButton icon={IconRemove} label="Fechar" onClick={onClose} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Seções: coluna à esquerda no computador, linha rolável no celular. */}
        <nav aria-label="Seções dos parâmetros" className="scroll-area flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 sm:w-44 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          {sections.map(item => <button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}
            className={`flex shrink-0 items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors ${section === item.id ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:bg-slate-50 hover:text-ink'}`}>
            <item.icon className="h-4 w-4 shrink-0" aria-hidden />{item.label}
          </button>)}
        </nav>

        <div className="scroll-area min-h-[19rem] min-w-0 flex-1 overflow-y-auto p-5">
          {loading ? (error ? <Alert>{error}</Alert> : <div className="space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-24" /></div>) : <div key={section} className="animate-fade-in space-y-4">
            {section === 'plano' && plan && <>
              <Heading title="Plano" aside={<Badge tone={preview.tone}>{preview.label}</Badge>}>A cobrança é por fora. Aqui fica até quando a conta está paga.</Heading>
              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Nome do plano"><input value={name} maxLength={40} onChange={e => edit(() => setName(e.target.value))} placeholder="Ex.: Mensal" className={inputClass} /></Field>
                <Field label="Valor por mês (R$)" hint={Number.isNaN(cents) ? 'Use o formato 147,00.' : 'Só você vê.'}>
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
                <span className="block text-2xs text-slate-400">A conta envia até o fim deste dia.</span>
              </div>
              <Checkbox checked={paused} onChange={value => edit(() => setPaused(value))} label="Conta pausada" hint="Guarda tudo, mas não envia. Para o mês em que o cliente não vai usar." />
            </>}

            {section === 'campanhas' && plan && <>
              <Heading title="Campanhas">Quanto a conta pode criar. Arquivadas e modelos não contam.</Heading>
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-muted">Limite de campanhas</span>
                <NumberRow value={maxCampaigns} onChange={value => edit(() => setMaxCampaigns(value))} range={plan.limits.maxCampaigns} label="Limite de campanhas" unit="campanhas na lista" />
                <span className="block text-2xs text-slate-400">Padrão do sistema: 8. Ao chegar no limite, o cliente arquiva ou exclui uma para criar outra.</span>
              </div>
              <div className="space-y-2">
                <Checkbox checked={maxGroups !== null} onChange={on => edit(() => setMaxGroups(on ? 50 : null))} label="Limitar os grupos por campanha" hint="Campanha com mais grupos do que isto não é criada nem iniciada." />
                {maxGroups !== null && <div className="pl-6"><NumberRow value={maxGroups} onChange={value => edit(() => setMaxGroups(value))} range={plan.limits.maxGroups} label="Grupos por campanha" unit="grupos por campanha" /></div>}
              </div>
            </>}

            {section === 'envios' && policy && rules && <>
              <Heading title="Envios">Regras que protegem o número. Envio segurado por uma regra espera, não falha.</Heading>
              <div className="space-y-2">
                <Checkbox checked={rules.quiet.enabled} onChange={enabled => setRule({ quiet: { ...rules.quiet, enabled } })} label="Horário de silêncio" hint="Nada sai nesse horário." />
                <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                  das {time(rules.quiet.start, start => setRule({ quiet: { ...rules.quiet, start } }), 'Início do silêncio')}
                  às {time(rules.quiet.end, end => setRule({ quiet: { ...rules.quiet, end } }), 'Fim do silêncio')}
                </div>
              </div>
              <div className="space-y-2">
                <Checkbox checked={rules.dailyLimit !== null} onChange={on => setRule({ dailyLimit: on ? policy.defaults.dailyLimit : null })} label="Limite de envios por dia" hint="Conta cada envio do número." />
                {rules.dailyLimit !== null && <div className="flex flex-wrap items-center gap-2 pl-6">
                  <NumberRow value={rules.dailyLimit} onChange={value => setRule({ dailyLimit: value })} range={policy.limits.dailyLimit} label="Envios por dia" unit="envios por dia" />
                  {policy.today !== null && policy.todayLimit !== null && <span className="tabular text-2xs text-muted">hoje: {numero(policy.today)} de {numero(policy.todayLimit)}{policy.todayLimit !== policy.dailyLimit ? ' (aquecendo)' : ''}</span>}
                </div>}
              </div>
              <div className="space-y-2">
                <Checkbox checked={rules.groupGapMinutes !== null} onChange={on => setRule({ groupGapMinutes: on ? policy.defaults.groupGapMinutes : null })} label="Intervalo mínimo no mesmo grupo" hint="O mesmo grupo não recebe de novo antes desse tempo." />
                {rules.groupGapMinutes !== null && <div className="pl-6">
                  <Select label="Intervalo no mesmo grupo" value={String(rules.groupGapMinutes)} onChange={value => setRule({ groupGapMinutes: Number(value) })} options={GAPS.map(m => ({ value: String(m), label: gapLabel(m) }))} className="w-48" />
                </div>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => edit(() => setRules({ ...pickRules(policy.defaults), autoPause: rules.autoPause }))}>Voltar ao recomendado</Button>
            </>}

            {section === 'whatsapp' && policy && rules && <>
              <Heading title="WhatsApp">O número desta conta e o que fazer se o WhatsApp reclamar.</Heading>
              <dl className="divide-y divide-line rounded border border-line text-sm">
                <div className="flex items-center justify-between gap-3 px-3 py-2"><dt className="text-xs text-muted">Conexão</dt><dd className="flex items-center gap-1.5 font-medium"><Dot tone={wa?.state === 'connected' ? 'ok' : wa?.state === 'error' ? 'warn' : 'off'} />{connectionLabel[wa?.state ?? 'disconnected'] ?? wa?.state}</dd></div>
                <div className="flex items-center justify-between gap-3 px-3 py-2"><dt className="text-xs text-muted">Número</dt><dd className="tabular font-medium">{wa?.accountJid ? `+${wa.accountJid.split('@')[0].split(':')[0]}` : 'sem número'}</dd></div>
                <div className="flex items-center justify-between gap-3 px-3 py-2"><dt className="text-xs text-muted">Envios hoje</dt><dd className="tabular font-medium">{policy.today === null ? 'sem número conectado' : `${numero(policy.today)}${policy.todayLimit !== null ? ` de ${numero(policy.todayLimit)}` : ''}`}</dd></div>
                <div className="flex items-center justify-between gap-3 px-3 py-2"><dt className="text-xs text-muted">Aquecimento</dt><dd className="font-medium">{!policy.warmup || policy.warmup.needsAnswer ? 'não respondido' : policy.warmup.day ? `dia ${policy.warmup.day} de ${policy.warmup.days}` : policy.warmup.isNew ? 'concluído' : 'número antigo'}</dd></div>
              </dl>
              <Checkbox checked={rules.autoPause} onChange={autoPause => setRule({ autoPause })} label="Pausar sozinho se o WhatsApp der sinal de restrição" hint="Pausa as campanhas da conta e avisa o cliente. Retomar é com ele." />
            </>}
          </div>}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <Button variant="primary" loading={busy} disabled={busy || loading || invalid || !(planChanged || rulesChanged)} onClick={() => void save()}>Salvar</Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Fechar</Button>
        {notice && !(planChanged || rulesChanged) && <span className="inline-flex animate-fade-in items-center gap-1 text-xs text-brand-700"><IconCheck className="h-3.5 w-3.5" aria-hidden />{notice}</span>}
        {!loading && error && <span className="text-xs text-red-700">{error}</span>}
      </footer>
    </div>
  </div>;
}
