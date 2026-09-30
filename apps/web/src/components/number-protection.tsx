import { useEffect, useState } from 'react';
import { api, errorMessage, type SafetyNotice } from '../lib/api';
import { Alert, Button, ButtonLink, Card, Checkbox, Select, IconAlert, IconCampaigns, IconCheck, dataHora, inputClass, numero } from '../design';

// Proteção do número (ADR-041): regras que a fila respeita além do intervalo entre envios.
// Um envio segurado por uma regra não falha: espera, e a previsão da campanha diz até quando.

type Rules = { quiet: { enabled: boolean; start: string; end: string }; dailyLimit: number | null; groupGapMinutes: number | null; autoPause: boolean };
type Policy = Rules & { defaults: Rules; limits: { dailyLimit: { min: number; max: number } }; today: number | null };

const GAPS = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
// Campo curto, na mesma linha do texto (o inputClass padrão ocupa a largura toda).
const shortInput = `${inputClass.replace('block w-full', 'inline-block')} w-32`;
const gapLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`) + (minutes === 120 ? ' (recomendado)' : '');

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

export function NumberProtection() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<Policy>('/sending-policy').then(p => { setPolicy(p); setDraft(p); }).catch(e => setError(errorMessage(e)));
  }, []);
  if (!policy || !draft) return <Card className="p-5"><p className="text-sm text-muted">{error || 'Carregando a proteção do número…'}</p></Card>;

  const set = (patch: Partial<Rules>) => { setDraft({ ...draft, ...patch }); setSaved(false); };
  const { min, max } = policy.limits.dailyLimit;
  const changed = JSON.stringify(pick(draft)) !== JSON.stringify(pick(policy));
  async function save(next: Rules) {
    setBusy(true); setError('');
    try {
      const stored = await api<Rules>('/sending-policy', { method: 'PUT', json: pick(next) });
      setPolicy({ ...policy!, ...stored }); setDraft(stored); setSaved(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  const time = (value: string, onChange: (v: string) => void, label: string) =>
    <input type="time" aria-label={label} value={value} disabled={!draft.quiet.enabled} onChange={e => onChange(e.target.value)} className={shortInput} />;

  return <Card className="space-y-4 p-5">
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">Proteção do número</h2>
      <p className="text-xs text-muted">Regras para o WhatsApp não restringir o seu número. Um envio segurado por uma regra não falha: espera e sai assim que a regra liberar.</p>
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
        {policy.today !== null && draft.dailyLimit !== null && <span className="tabular text-2xs text-muted">· hoje: {numero(policy.today)} de {numero(draft.dailyLimit)}</span>}
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
      hint="Número recusado, envios limitados ou várias mensagens recusadas em 1 hora: pausa todas as campanhas e avisa aqui. Retomar é com você." />

    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
      <Button variant="primary" loading={busy} disabled={busy || !changed || (draft.dailyLimit !== null && (draft.dailyLimit < min || draft.dailyLimit > max))} onClick={() => void save(draft)}>Salvar regras</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { setDraft(policy.defaults); setSaved(false); }}>Voltar ao recomendado</Button>
      {saved && !changed && <span className="inline-flex items-center gap-1 text-xs text-brand-700"><IconCheck className="h-3.5 w-3.5" aria-hidden />Salvo</span>}
    </div>
  </Card>;
}

const pick = ({ quiet, dailyLimit, groupGapMinutes, autoPause }: Rules): Rules => ({ quiet, dailyLimit, groupGapMinutes, autoPause });
