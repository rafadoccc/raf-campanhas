import { api } from '../lib/api';
import { useEffect, useState } from 'react';
import { startVisiblePolling } from '../lib/visible-polling';

export function ServerClock() {
  const [text, setText] = useState('…');
  useEffect(() => startVisiblePolling(async signal => {
    try {
      const data = await api<{ now: string; synchronized?: boolean; source?: string }>('/time', { signal });
      if (!signal.aborted) setText(data.synchronized === false ? 'hora não confirmada — verifique a internet' : new Date(data.now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    } catch { if (!signal.aborted) setText('indisponível'); }
    return 30000;
  }), []);
  return <p className="text-sm text-slate-500">Agora em Brasília: {text}</p>;
}
