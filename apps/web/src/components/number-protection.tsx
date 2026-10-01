import { useEffect, useState } from 'react';
import { api, errorMessage, type SafetyNotice } from '../lib/api';
import { Alert, Button, ButtonLink, Checkbox, Select, IconAlert, IconCampaigns, IconCheck, dataHora, inputClass, numero } from '../design';

// Proteção do número (ADR-041): regras que a fila respeita além do intervalo entre envios.
// Um envio segurado por uma regra não falha: espera, e a previsão da campanha diz até quando.
// Só o administrador vê e ajusta, conta por conta, na Administração (ADR-049, ADR-050).

type Rules = { quiet: { enabled: boolean; start: string; end: string }; dailyLimit: number | null; groupGapMinutes: number | null; autoPause: boolean };
type Policy = Rules & { defaults: Rules; limits: { dailyLimit: { min: number; max: number } }; today: number | null; todayLimit: number | null };

const GAPS = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
// Campo curto, na mesma linha do texto (o inputClass padrão ocupa a largura toda).
const shortInput = `${inputClass.replace('block w-full', 'inline-block')} w-32`;
const gapLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`) + (minutes === 120 ? ' (recomendado)' : '');

export type Warmup = { needsAnswer: true } | { needsAnswer: false; isNew: boolean; day: number | null; days: number; limitToday: number | null };

/**
 * Aquecimento de número novo (ADR-043). A pergunta aparece uma vez por número: reconectar o
 * mesmo número não pergunta de novo. Depois, dá para mudar a resposta aqui.
 */
export function WarmupPanel({ warmup, onChanged }: { warmup: Warmup; onChanged: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function answer(isNew: boolean) {
    setBusy(true); setError('');
    try { await api('/whatsapp/warmup', { method: 'POST', json: { isNew } }); onChanged(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  if (warmup.needsAnswer) return <div className="animate-fade-in space-y-3 rounded-md border border-brand-100 bg-brand-50 p-4 text-sm">
    <p className="font-semibold text-ink">Este número é novo (criado há menos de 1 mês)?</p>
    <p className="text-muted">Número novo que já sai mandando muito é o que o WhatsApp mais bane. Se for novo, o sistema começa devagar: <strong>30 envios por dia</strong> nos 3 primeiros dias, <strong>80</strong> até o 7º dia, e depois o limite normal.</p>
    {error && <Alert>{error}</Alert>}
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => void answer(true)}>Sim, é novo</Button>
      <Button size="sm" disabled={busy} onClick={() => void answer(false)}>Não, já uso há tempo</Button>
    </div>
  </div>;
  const link = 'text-2xs text-muted underline hover:text-ink disabled:opacity-50';
  if (warmup.isNew && warmup.day) return <div className="space-y-1">
    <Alert tone="brand">Aquecendo o número: dia {warmup.day} de {warmup.days} · até {warmup.limitToday} envios hoje. O limite sobe sozinho.</Alert>
    {error && <Alert>{error}</Alert>}
    <button type="button" className={link} disabled={busy} onClick={() => void answer(false)}>Não é um número novo? Parar o aquecimento</button>
  </div>;
  if (!warmup.isNew) return <div>
    {error && <Alert>{error}</Alert>}
    <button type="button" className={link} disabled={busy} onClick={() => void answer(true)}>Número novo? Ativar o aquecimento de 7 dias</button>
  </div>;
  return null; // aquecimento já terminou
}

/** Aviso de pausa automática: some quando a pessoa clica em "Entendi". */
export function SafetyAlert({ notice, onDismissed }: { notice: SafetyNotice; onDismissed: () => void }) {
  const [busy, setBusy] = useState(false);
  return <div role="alert" className="animate-fade-in space-y-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
    <p className="flex items-start gap-2 font-semibold"><IconAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Campanhas pausadas para proteger o seu número</p>
    <p>{notice.reason}{notice.at ? ` (${dataHora(notice.at)})` : ''}</p>
    <div className="flex flex-wrap gap-2">
      <ButtonLink to="/campanhas" size="sm" icon={IconCampaigns}>Ver campanhas</ButtonLink>
      <Button size="sm" variant="ghost" loading={busy} disabled={busy} onClick={() => {
        setBusy(true);
        void api('/whatsapp/safety/dismiss', { method: 'POST', json: {} }).then(onDismissed).catch(() => undefined).finally(() => setBusy(false));
      }}>Entendi</Button>
    </div>
  </div>;
}

export function NumberProtection({ userId }: { userId: string }) {
  const url = `/admin/users/${userId}/sending-policy`;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<Policy>(url).then(p => { setPolicy(p); setDraft(p); }).catch(e => setError(errorMessage(e)));
  }, [url]);
  if (!policy || !draft) return <p className="text-sm text-muted">{error || 'Carregando as regras de envio…'}</p>;

  const set = (patch: Partial<Rules>) => { setDraft({ ...draft, ...patch }); setSaved(false); };
  const { min, max } = policy.limits.dailyLimit;
  const changed = JSON.stringify(pick(draft)) !== JSON.stringify(pick(policy));
  async function save(next: Rules) {
    setBusy(true); setError('');
    try {
      const stored = await api<Rules>(url, { method: 'PUT', json: pick(next) });
      setPolicy({ ...policy!, ...stored }); setDraft(stored); setSaved(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  const time = (value: string, onChange: (v: string) => void, label: string) =>
    <input type="time" aria-label={label} value={value} disabled={!draft.quiet.enabled} onChange={e => onChange(e.target.value)} className={shortInput} />;

  return <section className="space-y-4">
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">Regras de envio</h3>
      <p className="text-xs text-muted">Protegem o número desta conta contra restrição do WhatsApp. Um envio segurado por uma regra não falha: espera e sai assim que a regra liberar.</p>
    </div>
    {error && <Alert>{error}</Alert>}

    <section className="space-y-2">
      <Checkbox checked={draft.quiet.enabled} onChange={enabled => set({ quiet: { ...draft.quiet, enabled } })} label="Horário de silêncio" hint="Nada sai nesse horário, para não acordar os membros dos grupos (é o que mais gera denúncia)." />
      <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
        das {time(draft.quiet.start, start => set({ quiet: { ...draft.quiet, start } }), 'Início do silêncio')}
        às {time(draft.quiet.end, end => set({ quiet: { ...draft.quiet, end } }), 'Fim do silêncio')}
      </div>
    </section>

    <section className="space-y-2">
      <Checkbox checked={draft.dailyLimit !== null} onChange={on => set({ dailyLimit: on ? policy.defaults.dailyLimit : null })} label="Limite de envios por dia"
        hint="Conta cada envio do número, inclusive para o mesmo grupo mais de uma vez." />
      <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
        <input type="number" inputMode="numeric" min={min} max={max} aria-label="Envios por dia" value={draft.dailyLimit ?? ''} disabled={draft.dailyLimit === null}
          onChange={e => set({ dailyLimit: e.target.value === '' ? min : Number(e.target.value) })} className={shortInput} />
        envios por dia
        {policy.today !== null && policy.todayLimit !== null && <span className="tabular text-2xs text-muted">· hoje: {numero(policy.today)} de {numero(policy.todayLimit)}{policy.todayLimit !== policy.dailyLimit ? ' (aquecendo)' : ''}</span>}
      </div>
    </section>

    <section className="space-y-2">
      <Checkbox checked={draft.groupGapMinutes !== null} onChange={on => set({ groupGapMinutes: on ? policy.defaults.groupGapMinutes : null })} label="Intervalo mínimo no mesmo grupo"
        hint="O mesmo grupo não recebe de novo antes desse tempo, mesmo vindo de outra campanha." />
      <div className="pl-6">
        <Select label="Intervalo no mesmo grupo" value={String(draft.groupGapMinutes ?? 120)} disabled={draft.groupGapMinutes === null}
          onChange={value => set({ groupGapMinutes: Number(value) })} options={GAPS.map(m => ({ value: String(m), label: gapLabel(m) }))} className="w-48" />
      </div>
    </section>

    <Checkbox checked={draft.autoPause} onChange={autoPause => set({ autoPause })} label="Pausar sozinho se o WhatsApp der sinal de restrição"
      hint="Número recusado, envios limitados ou várias mensagens recusadas em 1 hora: pausa todas as campanhas da conta e avisa o cliente no painel. Retomar é com ele." />

    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
      <Button variant="primary" loading={busy} disabled={busy || !changed || (draft.dailyLimit !== null && (draft.dailyLimit < min || draft.dailyLimit > max))} onClick={() => void save(draft)}>Salvar regras</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { setDraft(policy.defaults); setSaved(false); }}>Voltar ao recomendado</Button>
      {saved && !changed && <span className="inline-flex items-center gap-1 text-xs text-brand-700"><IconCheck className="h-3.5 w-3.5" aria-hidden />Salvo</span>}
    </div>
  </section>;
}

const pick = ({ quiet, dailyLimit, groupGapMinutes, autoPause }: Rules): Rules => ({ quiet, dailyLimit, groupGapMinutes, autoPause });
