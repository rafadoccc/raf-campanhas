import { api } from '../lib/api';
import { useEffect, useState } from 'react';
import { startVisiblePolling } from '../lib/visible-polling';

export function ServerClock() {
  const [text, setText] = useState('Consultando horário…');
  useEffect(() => startVisiblePolling(async signal => {
    try {
      const data = await api<{ now: string; synchronized?: boolean; source?: string }>('/time', { signal });
      if (!signal.aborted) setText(data.synchronized === false ? 'Sem referência de hora confirmada. Verifique a internet e sincronize o relógio do servidor' : new Date(data.now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23' }) + (data.source === 'cache' ? ' (última referência salva)' : ''));
    } catch { if (!signal.aborted) setText('Horário indisponível. Verifique a conexão.'); }
    return 30000;
  }), []);
  return <p className="mt-2 text-sm text-slate-600">Horário de Brasília: {text}. Os agendamentos usam America/Sao_Paulo.</p>;
}
