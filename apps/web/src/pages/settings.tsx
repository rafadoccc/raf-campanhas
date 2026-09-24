import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { startVisiblePolling, connectionPollDelay } from '../lib/visible-polling';
import { Alert, Button, Card, Dot, Page, PageHeader, IconOpen, IconRefresh, IconWhatsApp, IconDisable, useConfirm } from '../design';

type Connection = { state: string; qr?: string; accountJid?: string; error?: string };
const labels: Record<string, string> = { disconnected: 'Desconectado', connecting: 'Conectando…', qr: 'Aguardando leitura do QR Code', connected: 'Conectado', reconnecting: 'Reconectando…', error: 'Conexão interrompida' };

// Cada usuário conecta o PRÓPRIO WhatsApp (ADR-021): esta tela só enxerga a conexão de quem
// está logado. Status, QR e número vêm do servidor, escopados pela sessão.
export default function Settings() {
  const confirm = useConfirm();
  const [connection, setConnection] = useState<Connection>({ state: 'disconnected' });
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');

  async function refresh(signal?: AbortSignal) {
    try {
      const data = await api<Connection>('/whatsapp/status', { signal });
      if (!signal?.aborted) { setConnection(data); setError(''); }
      return data.state;
    } catch (e) {
      if (signal?.aborted) return;
      setError(errorMessage(e, 'Conector indisponível.'));
      return 'unavailable';
    }
  }

  // Durante o pareamento consulta a cada 2,5 s (o QR muda a cada 20 s); conectado, a cada 15 s.
  useEffect(() => {
    if (busy) return;
    return startVisiblePolling(async signal => connectionPollDelay(await refresh(signal)));
  }, [busy]);

  async function action(name: 'connect' | 'sync' | 'disconnect') {
    setBusy(true); setNotice('');
    try {
      const data = await api<{ count?: number }>(`/whatsapp/${name}`, { method: 'POST', json: {} });
      if (name === 'sync') setNotice(`${data.count} grupos sincronizados.`);
      await refresh();
    } catch (e) { setNotice(''); setError(errorMessage(e, 'Falha na operação.')); }
    finally { setBusy(false); }
  }

  const pairing = ['connecting', 'qr', 'reconnecting'].includes(connection.state);
  const connected = connection.state === 'connected';
  return <Page>
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader title="WhatsApp" subtitle="A conexão é sua: outros usuários conectam o próprio número." />
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded bg-brand-50 text-brand-700"><IconWhatsApp className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold"><Dot tone={connected ? 'ok' : pairing ? 'busy' : 'warn'} />{labels[connection.state] ?? connection.state}</p>
            {connection.accountJid && <p className="tabular text-xs text-muted">Número: {connection.accountJid.split('@')[0]}</p>}
          </div>
        </div>
        {connection.qr && <div className="flex flex-wrap items-center gap-4 rounded border border-line p-3">
          <img src={connection.qr} width={220} height={220} alt="QR Code para conectar o WhatsApp" className="rounded" />
          <p className="max-w-xs text-sm text-muted">No celular, abra <span className="inline-flex items-center gap-0.5 font-medium text-ink">WhatsApp<IconOpen className="h-3.5 w-3.5" aria-hidden />Aparelhos conectados<IconOpen className="h-3.5 w-3.5" aria-hidden />Conectar um aparelho</span> e leia este código. Ele se renova sozinho.</p>
        </div>}
        {(connection.error || error) && <Alert>{connection.error || error}</Alert>}
        {notice && <Alert tone="brand">{notice}</Alert>}
        <div className="flex flex-wrap gap-2">
          {!connected && <Button variant="primary" icon={IconWhatsApp} loading={busy && !pairing} disabled={busy || pairing} onClick={() => action('connect')}>{connection.state === 'error' ? 'Conectar novamente' : 'Conectar'}</Button>}
          {connected && <Button variant="primary" icon={IconRefresh} loading={busy} disabled={busy} onClick={() => action('sync')}>Sincronizar grupos</Button>}
          <Button variant="danger" icon={IconDisable} className="ml-auto" disabled={busy || connection.state === 'disconnected'} onClick={async () => {
            if (await confirm({ title: 'Desconectar o WhatsApp?', description: 'Este aparelho sai do seu WhatsApp e as campanhas reais param até você conectar de novo (será preciso ler o QR).', confirmLabel: 'Desconectar', danger: true })) void action('disconnect');
          }}>Desconectar</Button>
        </div>
      </Card>
      <p className="text-2xs text-muted">As campanhas rodam com o navegador fechado, desde que o sistema fique ligado.</p>
    </div>
  </Page>;
}
