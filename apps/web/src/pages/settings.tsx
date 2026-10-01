import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type SafetyNotice } from '../lib/api';
import { SafetyAlert, WarmupPanel, type Warmup } from '../components/number-protection';
import { OwnerAlerts } from '../components/owner-alerts';
import { startVisiblePolling, connectionPollDelay } from '../lib/visible-polling';
import { screenCache } from '../lib/cache';
import { Alert, Button, Card, Dot, Page, PageHeader, IconOpen, IconRefresh, IconWhatsApp, IconDisable, hora, useConfirm } from '../design';

type GroupsSync = { running: boolean; auto: boolean; at: string | null; count: number | null; error: string | null };
type Connection = { state: string; qr?: string; accountJid?: string; error?: string; groupsSync?: GroupsSync | null; ephemeralSession?: boolean; safety?: SafetyNotice; warmup?: Warmup };
const labels: Record<string, string> = { disconnected: 'Desconectado', connecting: 'Conectando…', qr: 'Aguardando leitura do QR Code', connected: 'Conectado', reconnecting: 'Reconectando…', error: 'Conexão interrompida' };
// Limite suave do botão: o servidor recusa sincronizar de novo antes disso.
const SYNC_COOLDOWN_MS = 30_000;

// Cada usuário conecta o PRÓPRIO WhatsApp (ADR-021): esta tela só enxerga a conexão de quem
// está logado. Status, QR e número vêm do servidor, escopados pela sessão. Ao conectar, o
// servidor sincroniza os grupos sozinho (ADR-035) e a tela avisa quando terminar.
export default function Settings() {
  const confirm = useConfirm();
  // null = ainda conferindo (antes aparecia "Desconectado" até a primeira resposta chegar).
  const [connection, setConnection] = useState<Connection | null>(() => screenCache.get<Connection>('whatsapp') ?? null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const syncedAt = useRef<string | null | undefined>(undefined);

  async function refresh(signal?: AbortSignal) {
    const generation = screenCache.generation();
    try {
      const data = await api<Connection>('/whatsapp/status', { signal });
      if (!signal?.aborted && screenCache.generation() === generation) {
        setConnection(data); setError('');
        screenCache.setIfCurrent('whatsapp', { ...data, qr: undefined }, generation); // QR vence em segundos: nunca reaproveitado
        // Grupos sincronizados de novo: a lista do formulário de campanha é buscada outra vez.
        if (syncedAt.current !== undefined && data.groupsSync?.at !== syncedAt.current) screenCache.delete('grupos');
        syncedAt.current = data.groupsSync?.at ?? null;
      }
      return data;
    } catch (e) {
      if (signal?.aborted || screenCache.generation() !== generation) return;
      setError(errorMessage(e, 'Conector indisponível.'));
      return { state: 'unavailable' } as Connection;
    }
  }

  // Pareando: a cada 2,5 s (o QR muda a cada 20 s). Conectado e sincronizando (ou esperando a
  // sincronização automática que vem logo depois de conectar): a cada 2 s. Depois, a cada 15 s.
  useEffect(() => {
    if (busy) return;
    return startVisiblePolling(async signal => {
      const data = await refresh(signal);
      if (data?.groupsSync?.running || (data?.state === 'connected' && !data.groupsSync?.at)) return 2000;
      return connectionPollDelay(data?.state);
    });
  }, [busy]);

  const sync = connection?.groupsSync ?? null;
  const cooldown = sync?.at && !sync.error ? Math.max(0, SYNC_COOLDOWN_MS - (now - Date.parse(sync.at))) : 0;
  // Relógio só enquanto o botão está em espera, para mostrar a contagem.
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown > 0]);

  async function action(name: 'connect' | 'sync' | 'disconnect') {
    setBusy(true); setError('');
    try {
      await api(`/whatsapp/${name}`, { method: 'POST', json: {} });
      await refresh();
      setNow(Date.now());
    } catch (e) { setError(errorMessage(e, 'Falha na operação.')); }
    finally { setBusy(false); }
  }

  const state = connection?.state ?? 'checking';
  const pairing = ['connecting', 'qr', 'reconnecting'].includes(state);
  const connected = state === 'connected';
  const syncing = busy || Boolean(sync?.running);
  return <Page>
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader title="WhatsApp" subtitle="A conexão é sua: outros usuários conectam o próprio número." />
      {connection?.safety && <SafetyAlert notice={connection.safety} onDismissed={() => void refresh()} />}
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded bg-brand-50 text-brand-700"><IconWhatsApp className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold"><Dot tone={connected ? 'ok' : pairing || !connection ? 'busy' : 'warn'} />{connection ? labels[state] ?? state : 'Verificando a conexão…'}</p>
            {connection?.accountJid && <p className="tabular text-xs text-muted">Número: {connection.accountJid.split('@')[0]}</p>}
          </div>
        </div>
        {connection?.qr && <div className="flex flex-wrap animate-fade-in items-center gap-4 rounded border border-line p-3">
          <img src={connection.qr} width={220} height={220} alt="QR Code para conectar o WhatsApp" className="rounded" />
          <p className="max-w-xs text-sm text-muted">No celular, abra <span className="inline-flex items-center gap-0.5 font-medium text-ink">WhatsApp<IconOpen className="h-3.5 w-3.5" aria-hidden />Aparelhos conectados<IconOpen className="h-3.5 w-3.5" aria-hidden />Conectar um aparelho</span> e leia este código. Os grupos são sincronizados sozinhos logo depois.</p>
        </div>}
        {/* Reconectando sozinho é aviso, não erro: o sistema está resolvendo. */}
        {(connection?.error || error) && <Alert tone={state === 'reconnecting' && !error ? 'warning' : 'danger'}>{connection?.error || error}</Alert>}
        {connection?.ephemeralSession && <Alert tone="warning">A sessão do WhatsApp está num disco que é apagado a cada atualização do sistema: cada deploy vai pedir o QR de novo. No Railway, adicione um Volume (ex.: /data) — o sistema passa a usá-lo sozinho.</Alert>}
        {connected && sync?.running && <Alert tone="info">Sincronizando os grupos do WhatsApp…</Alert>}
        {connected && !sync?.running && sync?.error && <Alert>Não foi possível sincronizar os grupos: {sync.error}</Alert>}
        {connected && !sync?.running && !sync?.error && sync?.at && <Alert tone="brand">
          {sync.count} {sync.count === 1 ? 'grupo sincronizado' : 'grupos sincronizados'}{sync.auto ? ' automaticamente ao conectar' : ''}, às {hora(sync.at)}.
        </Alert>}
        {connected && connection?.warmup && <WarmupPanel warmup={connection.warmup} onChanged={() => void refresh()} />}
        {/* Sempre uma linha: ação principal à esquerda, "Desconectar" à direita. Os rótulos têm
            tamanho fixo (a contagem da espera fica numa legenda embaixo, não no botão) e no
            celular "Sincronizar grupos" vira "Sincronizar" — cabe inteiro em 360 px. */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            {!connected && <Button variant="primary" icon={IconWhatsApp} loading={busy && !pairing} disabled={busy || pairing || !connection} onClick={() => action('connect')}>{state === 'error' ? 'Conectar de novo' : 'Conectar'}</Button>}
            {connected && <Button variant="primary" icon={IconRefresh} loading={syncing} disabled={syncing || cooldown > 0}
              title={cooldown ? `Aguarde ${Math.ceil(cooldown / 1000)} s para sincronizar de novo.` : 'Sincronizar grupos'}
              onClick={() => action('sync')}>Sincronizar<span className="hidden sm:inline">&nbsp;grupos</span></Button>}
            <Button variant="danger" icon={IconDisable} className="ml-auto" disabled={busy || !connection || state === 'disconnected'} onClick={async () => {
              if (await confirm({ title: 'Desconectar o WhatsApp?', description: 'Este aparelho sai do seu WhatsApp e as campanhas reais param até você conectar de novo (será preciso ler o QR).', confirmLabel: 'Desconectar', danger: true })) void action('disconnect');
            }}>Desconectar</Button>
          </div>
          {connected && cooldown > 0 && <p className="tabular text-2xs text-slate-400" aria-live="polite">Sincronizar de novo disponível em {Math.ceil(cooldown / 1000)} s.</p>}
        </div>
      </Card>
      <OwnerAlerts connected={connected} />
      <p className="text-2xs text-muted">As campanhas rodam com o navegador fechado, desde que o sistema fique ligado.</p>
    </div>
  </Page>;
}
