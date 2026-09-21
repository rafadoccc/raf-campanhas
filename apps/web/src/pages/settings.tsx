import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { startVisiblePolling, connectionPollDelay } from '../lib/visible-polling';

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
      if (name === 'sync') setNotice(`${data.count} grupos sincronizados. Selecione os desejados ao criar uma campanha.`);
      await refresh();
    } catch (e) { setNotice(errorMessage(e, 'Falha na operação.')); }
    finally { setBusy(false); }
  }

  const pairing = ['connecting', 'qr', 'reconnecting'].includes(connection.state);
  return <main className="mx-auto max-w-3xl space-y-6 p-8">
    <header><p className="text-sm font-semibold text-emerald-700">CONEXÃO</p><h1 className="mt-2 text-3xl font-bold">Seu WhatsApp</h1><p className="mt-3 text-slate-600">Conecte seu celular para importar os grupos dos quais você participa.</p></header>
    <section className="space-y-4 rounded-xl border bg-white p-6">
      <h2 className="text-xl font-semibold">{labels[connection.state] ?? connection.state}</h2>
      {connection.accountJid && <p>Número conectado: {connection.accountJid.split('@')[0]}</p>}
      {connection.qr && <div className="space-y-2">
        <img src={connection.qr} width={300} height={300} alt="QR Code para conectar o WhatsApp" />
        <p>No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho. Leia este código.</p>
        <p className="text-sm text-slate-500">O código se renova sozinho a cada 20 segundos; leia sempre o que está na tela.</p>
      </div>}
      {(connection.error || error) && <p role="alert" className="text-red-700">{connection.error || error}</p>}
      <div className="flex flex-wrap gap-3">
        <button disabled={busy || pairing || connection.state === 'connected'} onClick={() => action('connect')} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-40">{connection.state === 'error' ? 'Conectar novamente' : 'Conectar / gerar QR Code'}</button>
        <button disabled={busy || connection.state !== 'connected'} onClick={() => action('sync')} className="rounded-lg border px-4 py-2 disabled:opacity-40">Sincronizar grupos</button>
        <button disabled={busy} onClick={() => { if (confirm('Desconectar este aparelho? Campanhas reais não serão enviadas enquanto estiver desconectado.')) void action('disconnect'); }} className="rounded-lg border px-4 py-2 text-red-700">Desconectar</button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
    <p className="text-sm text-slate-500">Mantenha o sistema ligado. A fila continua sem o navegador; ao reiniciar, conecte novamente para continuar os pendentes, respeitando o intervalo. Envios simulados não chegam ao celular.</p>
  </main>;
}
