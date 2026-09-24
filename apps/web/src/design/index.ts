// Design system do painel (docs/design-system.md). As telas importam daqui, nunca montam
// botões, selos ou ícones por conta própria.
export * from './primitives';
export * from './format';
export * from './icons';
export { ConfirmProvider, useConfirm } from './confirm';
export { useInfiniteList, LoadMoreSentinel, type PageResult } from './infinite';
