import type { Tone } from '../design';

// Sugestões e críticas (ADR-045): tipos e situações, iguais aos do servidor (feedback-routes.ts).
export type FeedbackKind = 'sugestao' | 'problema' | 'critica' | 'elogio';
export type FeedbackStatus = 'novo' | 'analisando' | 'feito' | 'recusado';
export type Feedback = { id: string; kind: FeedbackKind; message: string; status: FeedbackStatus; reply: string | null; repliedAt: string | null; createdAt: string };

export const FEEDBACK_MAX_LENGTH = 2000;
export const feedbackKinds: { value: FeedbackKind; label: string; placeholder: string }[] = [
  { value: 'sugestao', label: 'Sugestão', placeholder: 'O que você gostaria que o sistema fizesse?' },
  { value: 'problema', label: 'Problema', placeholder: 'O que aconteceu, em qual tela e o que você esperava?' },
  { value: 'critica', label: 'Crítica', placeholder: 'O que incomoda ou poderia ser melhor?' },
  { value: 'elogio', label: 'Elogio', placeholder: 'Do que você gostou?' },
];
export const feedbackKindLabel = Object.fromEntries(feedbackKinds.map(k => [k.value, k.label])) as Record<FeedbackKind, string>;
export const feedbackStatus: Record<FeedbackStatus, { label: string; tone: Tone }> = {
  novo: { label: 'Recebido', tone: 'neutral' },
  analisando: { label: 'Em análise', tone: 'info' },
  feito: { label: 'Feito', tone: 'brand' },
  recusado: { label: 'Não vamos fazer', tone: 'warning' },
};
