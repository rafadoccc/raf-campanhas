import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Alert, Button, Card, Checkbox, Segmented, IconCheck, dataHora, inputClass } from '../design';

// Avisos no WhatsApp do dono (ADR-048): uma mensagem quando uma campanha real termina e quando o
// sistema pausa as campanhas para proteger o número. O destino é o próprio número conectado (a
// conversa "Você", sem som) ou outro número, que recebe como mensagem normal.

type Recent = { title: string; detail: string; createdAt: string; sentAt: string | null; error: string | null };
type Alerts = { enabled: boolean; phone: string | null; connected: boolean; recent: Recent[] };
type Where = 'own' | 'other';

const WHERE: readonly { value: Where; label: string }[] = [{ value: 'own', label: 'Neste número' }, { value: 'other', label: 'Em outro número' }];

/** 5511912345678 vira (11) 91234-5678; número de fora do Brasil fica com o código do país. */
function pretty(phone: string) {
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return br ? `(${br[1]}) ${br[2]}-${br[3]}` : `+${phone}`;
}

export function OwnerAlerts({ connected }: { connected: boolean }) {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [where, setWhere] = useState<Where>('own');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  function load(data: Alerts) {
    setAlerts(data); setEnabled(data.enabled);
    setWhere(data.phone ? 'other' : 'own'); setPhone(data.phone ? pretty(data.phone) : '');
  }
  useEffect(() => { api<Alerts>('/alerts').then(load).catch(e => setError(errorMessage(e))); }, []);
  if (!alerts) return <Card className="p-5"><p className="text-sm text-muted">{error || 'Carregando os avisos…'}</p></Card>;

  const savedPhone = alerts.phone ? pretty(alerts.phone) : '';
  const changed = enabled !== alerts.enabled || where !== (alerts.phone ? 'other' : 'own') || (where === 'other' && phone.trim() !== savedPhone);
  const missingPhone = where === 'other' && !phone.trim();
  const edit = (change: () => void) => { change(); setNotice(''); setError(''); };

  async function save() {
    setBusy('save'); setError(''); setNotice('');
    try {
      load(await api<Alerts>('/alerts', { method: 'PUT', json: { enabled, phone: where === 'other' ? phone : null } }));
      setNotice('Salvo');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setError(''); setNotice('');
    try {
      load(await api<Alerts>('/alerts/test', { method: 'POST', json: {} }));
      setNotice('Aviso de teste enviado. Confira o WhatsApp.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(null); }
  }

  return <Card className="space-y-4 p-5">
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">Avisos no WhatsApp</h2>
      <p className="text-xs text-muted">Uma mensagem quando uma campanha termina, com quantos envios saíram e quantos falharam, e quando o sistema pausa as campanhas para proteger o seu número.</p>
    </div>
    {error && <Alert>{error}</Alert>}

    <Checkbox checked={enabled} onChange={value => edit(() => setEnabled(value))} label="Receber avisos" hint="Avisos não contam no limite de envios do dia e nunca vão para grupos." />

    <section className="space-y-2 pl-6">
      <Segmented label="Onde receber os avisos" value={where} onChange={value => edit(() => setWhere(value))} options={WHERE} />
      {where === 'own'
        ? <p className="text-xs text-muted">O aviso aparece na conversa com você mesmo (o WhatsApp mostra como <strong>Você</strong>). Por ser uma mensagem do seu próprio número, o celular não toca nem mostra notificação.</p>
        : <div className="space-y-1.5">
          <input type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={40} onChange={e => edit(() => setPhone(e.target.value))}
            placeholder="DDD e número, ex.: 11 91234-5678" aria-label="Número que recebe os avisos" className={`${inputClass} max-w-xs`} />
          <p className="text-xs text-muted">Chega como uma mensagem normal, com som e notificação. Use o seu número pessoal e salve nele o contato do número das campanhas.</p>
        </div>}
    </section>

    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
      <Button variant="primary" loading={busy === 'save'} disabled={Boolean(busy) || !changed || missingPhone} onClick={() => void save()}>Salvar avisos</Button>
      <Button loading={busy === 'test'} disabled={Boolean(busy) || changed || !connected}
        title={!connected ? 'Conecte o WhatsApp para testar' : changed ? 'Salve antes de testar' : undefined} onClick={() => void test()}>Enviar aviso de teste</Button>
      {notice && !changed && <span className="inline-flex items-center gap-1 text-xs text-brand-700"><IconCheck className="h-3.5 w-3.5" aria-hidden />{notice}</span>}
    </div>

    {alerts.recent.length > 0 && <section className="space-y-2 border-t border-line pt-4">
      <h3 className="text-xs font-medium text-muted">Últimos avisos</h3>
      <ul className="space-y-2">
        {alerts.recent.map(item => <li key={`${item.createdAt}${item.title}`} className="space-y-0.5 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-medium text-ink"><span className="tabular mr-2 font-normal text-slate-400">{dataHora(item.createdAt)}</span>{item.title}</span>
            <span className={item.error ? 'text-red-700' : item.sentAt ? 'text-brand-700' : 'text-muted'}>{item.error ? 'Não enviado' : item.sentAt ? 'Enviado' : 'Na fila'}</span>
          </div>
          {item.detail && <p className="text-muted">{item.detail}</p>}
          {item.error && <p className="text-red-700">{item.error.replace(/^Não enviado: /, 'Motivo: ')}</p>}
        </li>)}
      </ul>
    </section>}
  </Card>;
}
