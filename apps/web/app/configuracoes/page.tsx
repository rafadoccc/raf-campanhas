'use client';
import { API_URL } from '../../components/api-url';
import { useEffect, useState } from 'react';
import { startVisiblePolling, connectionPollDelay } from '../../components/visible-polling';
const api = API_URL;
type Connection = { state: string; qr?: string; accountJid?: string; error?: string };
const labels: Record<string, string> = { disconnected: 'Desconectado', connecting: 'Conectando…', qr: 'Aguardando leitura do QR Code', connected: 'Conectado', reconnecting: 'Reconectando…', error: 'Conexão interrompida' };
export default function Settings() {
  const [connection, setConnection] = useState<Connection>({ state: 'disconnected' });
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  async function refresh(signal?: AbortSignal) {
    try { const r = await fetch(`${api}/whatsapp/status`, { signal, cache: 'no-store' }); const data = await r.json(); if (!r.ok) throw new Error(data.error); if (!signal?.aborted) { setConnection(data); setError(''); } return data.state as string; }
    catch { if (signal?.aborted) return; setError('Conector indisponível. Inicie o sistema com npm run start:local.'); return 'unavailable'; }
  }
  useEffect(() => {
    if (busy) return;
    return startVisiblePolling(async signal => connectionPollDelay(await refresh(signal)));
  }, [busy]);
  async function action(name: string) {
    setBusy(true); setNotice('');
    try { const r = await fetch(`${api}/whatsapp/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const data = await r.json(); if (!r.ok) throw new Error(data.error); if (name === 'sync') setNotice(`${data.count} grupos sincronizados. Selecione os desejados ao criar uma campanha.`); await refresh(); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Falha na operação.'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl space-y-6 p-8"><header><p className="text-sm font-semibold text-emerald-700">CONEXÃO</p><h1 className="mt-2 text-3xl font-bold">Seu WhatsApp</h1><p className="mt-3 text-slate-600">Conecte seu celular para importar os grupos dos quais você participa.</p></header>
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Baileys é uma integração não oficial. A conexão pode parar de funcionar e existe risco de restrição do número. Conectar não ativa campanhas automaticamente.</div>
    <section className="space-y-4 rounded-xl border bg-white p-6"><h2 className="text-xl font-semibold">{labels[connection.state] ?? connection.state}</h2>
      {connection.accountJid && <p>Número conectado: {connection.accountJid.split('@')[0]}</p>}
      {connection.qr && <div><img src={connection.qr} width={300} height={300} alt="QR Code para conectar o WhatsApp" /><p>No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho. Leia este código.</p></div>}
      {(connection.error || error) && <p role="alert" className="text-red-700">{connection.error || error}</p>}
      <div className="flex flex-wrap gap-3"><button disabled={busy || ['connecting', 'qr', 'connected', 'reconnecting'].includes(connection.state)} onClick={() => action('connect')} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-40">Conectar / gerar QR Code</button>
      <button disabled={busy || connection.state !== 'connected'} onClick={() => action('sync')} className="rounded-lg border px-4 py-2 disabled:opacity-40">Sincronizar grupos</button>
      <button disabled={busy} onClick={() => { if (confirm('Desconectar este aparelho? Campanhas reais não serão enviadas enquanto estiver desconectado.')) void action('disconnect'); }} className="rounded-lg border px-4 py-2 text-red-700">Desconectar</button></div>
      {notice && <p role="status">{notice}</p>}
    </section><p className="text-sm text-slate-500">Mantenha o computador e o sistema ligados. A fila continua sem o navegador; ao reiniciar, conecte novamente para continuar os pendentes, respeitando o intervalo. Envios simulados não chegam ao celular.</p>
  </main>;
}
