import type { ReactNode } from 'react';
import { IconClock, IconGroups, IconPeriod, IconQueue, dia, duracaoRodada, type Icon } from '../design';

// Resumo de uma campanha em itens curtos, cada um com o próprio ícone: quantos grupos, quando
// sai e em que período (o @todos aparece na própria mensagem, não aqui). Um lugar só para o cartão da lista e para o topo do
// detalhe, para os dois dizerem a mesma coisa do mesmo jeito. Sem separadores de texto ("·"):
// quando a linha quebra, um separador ficava solto no começo da linha de baixo.
//
// Só entra o que ainda serve na situação da campanha: horários e duração da rodada são o PLANO,
// e deixam de importar quando ela termina (aí ficam os grupos e o período em que rodou).

type Props = {
  groups: number;
  mode: string;
  schedules: { time: string }[];
  startsAt?: string; endsAt?: string;
  /** Situação da campanha; sem ela (modelos), mostra o plano inteiro. */
  status?: string;
  /** Campanha antiga que rodou em simulação (o modo saiu da tela, o histórico ficou). */
  simulated?: boolean;
  /** Topo do detalhe: há espaço para a duração aproximada da rodada. */
  detailed?: boolean;
};

const MAX_TIMES = 3;

function Item({ icon: IconCmp, title, children }: { icon: Icon; title?: string; children: ReactNode }) {
  return <span title={title} className="inline-flex min-w-0 items-center gap-1.5">
    <IconCmp className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden /><span className="truncate">{children}</span>
  </span>;
}

export function CampaignMeta({ groups, mode, schedules, startsAt, endsAt, status, simulated, detailed }: Props) {
  const immediate = mode === 'IMMEDIATE';
  const ended = status === 'COMPLETED' || status === 'CANCELLED';
  const times = schedules.map(s => s.time).sort();
  const shown = times.slice(0, MAX_TIMES).join(' · ') + (times.length > MAX_TIMES ? ` +${times.length - MAX_TIMES}` : '');
  const period = startsAt && endsAt ? (dia(startsAt) === dia(endsAt) ? dia(startsAt) : `${dia(startsAt)} a ${dia(endsAt)}`) : null;
  return <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted">
    <Item icon={IconGroups}>{groups} {groups === 1 ? 'grupo' : 'grupos'}</Item>
    {!ended && (immediate
      ? <Item icon={IconClock}>Fila única</Item>
      : <Item icon={IconClock} title={`Horários: ${times.join(', ')}`}><span className="tabular">{shown}</span></Item>)}
    {!immediate && period && <Item icon={IconPeriod}><span className="tabular">{period}</span></Item>}
    {detailed && !ended && groups > 1 && <Item icon={IconQueue} title="Tempo aproximado para passar por todos os grupos.">{duracaoRodada(groups)} por rodada</Item>}
    {simulated && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-2xs">simulação</span>}
  </div>;
}
