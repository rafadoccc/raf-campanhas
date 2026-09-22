import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { startVisiblePolling, connectionPollDelay } from '../lib/visible-polling';
import { card, PageHeader, page, primaryButton } from '../components/ui';

type Connection = { state: string; qr?: string; accountJid?: string; error?: string };
const labels: Record<string, string> = { disconnected: 'Desconectado', connecting: 'Conectando…', qr: 'Aguardando leitura do QR Code', connected: 'Conectado', reconnecting: 'Reconectando…', error: 'Conexão interrompida' };

export default function Settings() {
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
    } catch (e) { setNotice(errorMessage(e, 'Falha na operação.')); }
    finally { setBusy(false); }
  }

  const pairing = ['connecting', 'qr', 'reconnecting'].includes(connection.state);
  const connected = connection.state === 'connected';
  return <main className={`${page} max-w-3xl`}>
    <PageHeader title="WhatsApp" />
    <section className={`${card} space-y-4 p-6`}>
      <p className="flex items-center gap-2 text-lg font-semibold"><span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : pairing ? 'bg-sky-500' : 'bg-amber-500'}`} />{labels[connection.state] ?? connection.state}</p>
      {connection.accountJid && <p className="text-sm text-slate-600">Número: {connection.accountJid.split('@')[0]}</p>}
      {connection.qr && <div className="space-y-2">
        <img src={connection.qr} width={300} height={300} alt="QR Code para conectar o WhatsApp" />
        <p className="text-sm">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho.</p>
      </div>}
      {(connection.error || error) && <p role="alert" className="text-red-700">{connection.error || error}</p>}
      <div className="flex flex-wrap gap-3">
        {!connected && <button type="button" disabled={busy || pairing} onClick={() => action('connect')} className={primaryButton}>{connection.state === 'error' ? 'Conectar novamente' : 'Conectar'}</button>}
        {connected && <button type="button" disabled={busy} onClick={() => action('sync')} className={primaryButton}>Sincronizar grupos</button>}
        <button type="button" disabled={busy} onClick={() => { if (confirm('Desconectar? Campanhas reais param até reconectar.')) void action('disconnect'); }} className="ml-auto rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50">Desconectar</button>
      </div>
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    </section>
    <p className="mt-4 text-xs text-slate-500">As campanhas rodam com o navegador fechado, desde que o sistema fique ligado.</p>
  </main>;
}
