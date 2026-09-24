import type { Tone } from './primitives';

// Formatos e estados compartilhados pelas telas (horário sempre de Brasília).
const TZ = 'America/Sao_Paulo';
export const hora = (at: string | Date) => new Date(at).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const horaSeg = (at: string | Date) => new Date(at).toLocaleTimeString('pt-BR', { timeZone: TZ, hourCycle: 'h23' });
export const dataHora = (at: string | Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
/** Datas de campanha são gravadas como meia-noite UTC do dia escolhido. */
export const dia = (at: string | Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(new Date(at));
export const numero = (n: number) => n.toLocaleString('pt-BR');
/** Piso de intervalo entre grupos (ADR-028): o servidor recusa qualquer valor abaixo disso. */
export const MIN_INTERVAL_MINUTES = 3;
export const tamanho = (bytes: number) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
export const membros = (n?: number | null) => (n == null ? null : `${numero(n)} ${n === 1 ? 'membro' : 'membros'}`);
export const tempoRelativo = (at: string | Date, agora = Date.now()) => {
  const min = Math.round((new Date(at).getTime() - agora) / 60_000);
  if (Math.abs(min) < 1) return 'agora';
  if (min > 0) return min < 60 ? `em ${min} min` : `em ${Math.round(min / 60)} h`;
  return -min < 60 ? `há ${-min} min` : `há ${Math.round(-min / 60)} h`;
};

export const campaignStatus: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  ACTIVE: { label: 'Ativa', tone: 'brand' },
  PAUSED: { label: 'Pausada', tone: 'warning' },
  COMPLETED: { label: 'Concluída', tone: 'info' },
  CANCELLED: { label: 'Encerrada', tone: 'muted' },
};

export type Wait = { expectedAt: string; lateMinutes: number; reason: string | null };
type DeliveryLike = { status: string; provider: string; deliveredAt?: string | null; serverRejectedAt?: string | null; attempts?: number; wait?: Wait | null };

// Situação de um envio (ADR-012/014). "Enviado" = o WhatsApp recebeu o pedido; "Entregue" exige
// o recibo de entrega de algum membro. Zero leituras não quer dizer que não chegou.
export function deliveryStatus(d: DeliveryLike): { label: string; tone: Tone; title?: string } {
  if (d.status === 'SENT' && d.provider === 'simulator') return { label: 'Simulado', tone: 'muted' };
  if (d.status === 'SENT' && d.deliveredAt) return { label: 'Entregue', tone: 'brand', title: 'Recibo de entrega de pelo menos um membro' };
  if (d.status === 'SENT') return { label: 'Enviado', tone: 'brand', title: 'O WhatsApp recebeu; aguardando recibo de entrega' };
  if (d.status === 'PROCESSING') return { label: 'Enviando', tone: 'info' };
  if (d.status === 'PENDING' && (d.attempts ?? 0) > 0) return { label: 'Nova tentativa', tone: 'warning' };
  if (d.status === 'PENDING' && (d.wait?.lateMinutes ?? 0) > 0) return { label: 'Atrasado', tone: 'warning' };
  if (d.status === 'PENDING') return { label: 'Aguardando', tone: 'neutral' };
  if (d.status === 'FAILED' && d.serverRejectedAt) return { label: 'Recusado', tone: 'danger', title: 'O WhatsApp recusou a mensagem' };
  if (d.status === 'FAILED') return { label: 'Falhou', tone: 'danger' };
  return { label: 'Cancelado', tone: 'muted' };
}

// Cor de destaque a partir da cor predominante da imagem da campanha (ADR-026). Clareia ou
// escurece o necessário para a faixa ficar visível sobre o branco e o texto legível sobre ela.
const NEUTRAL = '#94a3b8';
function rgb(hex: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
const luminance = ([r, g, b]: number[]) => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const toHex = (c: number[]) => `#${c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
export function accent(color?: string | null) {
  let c = color ? rgb(color) : null;
  if (!c) c = rgb(NEUTRAL)!;
  // Muito clara (ex.: fundo branco): escurece até aparecer sobre o cartão.
  while (luminance(c) > 0.6) c = c.map(v => v * 0.85);
  return { solid: toHex(c), soft: `${toHex(c)}14`, border: `${toHex(c)}40`, text: luminance(c) > 0.35 ? '#161b22' : '#ffffff' };
}
