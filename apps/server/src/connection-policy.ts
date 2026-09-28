// O que fazer quando a conexão com o WhatsApp cai, por motivo. Os códigos são os de
// DisconnectReason do Baileys; ficam literais aqui para a regra ser testável sem socket.
export const CODE = {
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408, // também usado para "connectionLost"
  multideviceMismatch: 411,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  unavailableService: 503,
  restartRequired: 515,
} as const;

/** Espera máxima entre tentativas: uma por minuto, sem martelar o WhatsApp. */
export const MAX_RETRY_DELAY_MS = 60_000;

/** 1 s, 2 s, 4 s… até 1 min, e daí em diante a cada minuto. Nunca desiste sozinho (ADR-036). */
export const retryDelay = (retries: number) => Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(retries, 16));

export type CloseAction =
  | { kind: 'reconnect'; delayMs: number; countsAsRetry: boolean }
  | { kind: 'stop'; clearSession: boolean; error: string };

// ADR-036: a sessão só é apagada quando o próprio WhatsApp diz que o aparelho saiu (401). Antes,
// o código 500 também apagava — mas 500 é o código que o Baileys usa para QUALQUER erro de fluxo
// sem código conhecido (inclusive instabilidade passageira do servidor), e cada ocorrência
// obrigava a ler o QR de novo. E ~1 min sem rede fazia a conexão desistir de vez.
export function closeAction(code: number | undefined, message: string | undefined, retries: number): CloseAction {
  const suffix = code ? ` (código ${code})` : '';
  // O QR foi renovado até o limite e ninguém leu: não é falha de rede, e reconectar em
  // laço só geraria QRs novos sem ninguém olhando.
  if (/QR refs attempts ended/i.test(message ?? '')) {
    return { kind: 'stop', clearSession: false, error: 'O QR Code expirou sem ser lido. Clique em Conectar para gerar outro.' };
  }
  switch (code) {
    // Depois de ler o QR, o WhatsApp sempre pede para reiniciar a conexão: é o passo final
    // do pareamento, não um erro.
    case CODE.restartRequired:
      return { kind: 'reconnect', delayMs: 0, countsAsRetry: false };
    case CODE.loggedOut:
      return { kind: 'stop', clearSession: true, error: `Este aparelho foi desconectado no celular${suffix}. Clique em Conectar e leia o novo QR Code.` };
    case CODE.multideviceMismatch:
      return { kind: 'stop', clearSession: false, error: `O WhatsApp recusou esta sessão${suffix}. Clique em Conectar; se pedir, leia o QR Code.` };
    case CODE.connectionReplaced:
      return { kind: 'stop', clearSession: false, error: `Esta conta foi aberta em outra janela do sistema${suffix}. Feche a outra e clique em Conectar.` };
    case CODE.forbidden:
      return { kind: 'stop', clearSession: false, error: `O WhatsApp recusou este número${suffix}. Confira no celular se há alguma restrição.` };
  }
  // Rede, servidor instável (500, 503), tempo esgotado: tenta de novo, cada vez mais espaçado.
  return { kind: 'reconnect', delayMs: retryDelay(retries), countsAsRetry: true };
}
