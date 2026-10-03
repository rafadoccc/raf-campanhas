import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Alert, Button, Card, Checkbox, Segmented, IconCheck, dataHora, inputClass } from '../design';

// Avisos no WhatsApp do dono (ADR-048): uma mensagem quando uma campanha real termina e quando o
// sistema pausa as campanhas para proteger o número. O destino é o próprio número conectado (a
// conversa "Você", sem som) ou outro número, que recebe como mensagem normal.
// Cartão enxuto (pedido do dono, 2026-10-03): pouco texto, e o destino só aparece com os avisos ligados.

type Recent = { title: string; detail: string; createdAt: string; sentAt: string | null; error: string | null };
type Alerts = { enabled: boolean; phone: string | null; connected: boolean; recent: Recent[] };
type Where = 'own' | 'other';

const WHERE: readonly { value: Where; label: string }[] = [{ value: 'own', label: 'Neste número' }, { value: 'other', label: 'Em outro número' }];

/** 5511912345678 vira (11) 91234-5678; número de fora do Brasil fica com o código do país. */
function pretty(phone: string) {
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return br ? `(${br[1]}) ${br[2]}-${br[3]}` : `+${phone}`;
}

export function OwnerAlerts() {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [where, setWhere] = useState<Where>('own');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  function load(data: Alerts) {
    setAlerts(data); setEnabled(data.enabled);
    setWhere(data.phone ? 'other' : 'own'); setPhone(data.phone ? pretty(data.phone) : '');
  }
  useEffect(() => { api<Alerts>('/alerts').then(load).catch(e => setError(errorMessage(e))); }, []);
  if (!alerts) return <Card className="p-5"><p className="text-sm text-muted">{error || 'Carregando os avisos…'}</p></Card>;

  const savedPhone = alerts.phone ? pretty(alerts.phone) : '';
  const changed = enabled !== alerts.enabled || where !== (alerts.phone ? 'other' : 'own') || (where === 'other' && phone.trim() !== savedPhone);
  const missingPhone = enabled && where === 'other' && !phone.trim();
  const edit = (change: () => void) => { change(); setSaved(false); setError(''); };

  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try {
      load(await api<Alerts>('/alerts', { method: 'PUT', json: { enabled, phone: where === 'other' ? phone : null } }));
      setSaved(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return <Card className="space-y-4 p-5">
    <Checkbox checked={enabled} onChange={value => edit(() => setEnabled(value))}
      label={<span className="font-semibold">Avisos no WhatsApp</span>} hint="Avisa quando uma campanha termina ou é pausada." />

    {enabled && <div className="animate-fade-in space-y-2 pl-6">
      <Segmented label="Onde receber os avisos" value={where} onChange={value => edit(() => setWhere(value))} options={WHERE} />
      {where === 'own'
        ? <p className="text-2xs text-slate-400">Chega na conversa com você mesmo, sem notificação.</p>
        : <>
          <input type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={40} onChange={e => edit(() => setPhone(e.target.value))}
            placeholder="DDD e número" aria-label="Número que recebe os avisos" className={`${inputClass} max-w-xs`} />
          <p className="text-2xs text-slate-400">Chega como mensagem normal, com notificação.</p>
        </>}
    </div>}

    {error && <Alert>{error}</Alert>}
    {(changed || saved) && <div className="flex items-center gap-2">
      {changed && <Button variant="primary" size="sm" loading={busy} disabled={busy || missingPhone} onClick={() => void save()}>Salvar</Button>}
      {saved && !changed && <span className="inline-flex animate-fade-in items-center gap-1 text-xs text-brand-700"><IconCheck className="h-3.5 w-3.5" aria-hidden />Salvo</span>}
    </div>}

    {alerts.recent.length > 0 && <ul className="space-y-1.5 border-t border-line pt-3">
      {alerts.recent.slice(0, 3).map(item => <li key={`${item.createdAt}${item.title}`} title={item.error ?? item.detail} className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate"><span className="tabular mr-2 text-slate-400">{dataHora(item.createdAt)}</span>{item.title}</span>
        <span className={`shrink-0 text-2xs ${item.error ? 'text-red-700' : item.sentAt ? 'text-brand-700' : 'text-muted'}`}>{item.error ? 'Não enviado' : item.sentAt ? 'Enviado' : 'Na fila'}</span>
      </li>)}
    </ul>}
  </Card>;
}
