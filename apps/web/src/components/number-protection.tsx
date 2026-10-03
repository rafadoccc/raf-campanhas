import { useState } from 'react';
import { api, errorMessage, type SafetyNotice } from '../lib/api';
import { Alert, Button, ButtonLink, IconAlert, IconCampaigns, dataHora } from '../design';

// Proteção do número (ADR-041): regras que a fila respeita além do intervalo entre envios.
// Um envio segurado por uma regra não falha: espera, e a previsão da campanha diz até quando.
// Só o administrador vê e ajusta, conta por conta, na Administração (ADR-049, ADR-050).

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
