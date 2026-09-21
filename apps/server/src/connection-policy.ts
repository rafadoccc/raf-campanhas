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

export const MAX_RETRIES = 6;

export type CloseAction =
  | { kind: 'reconnect'; delayMs: number; countsAsRetry: boolean }
  | { kind: 'stop'; clearSession: boolean; error: string };

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
    case CODE.badSession:
    case CODE.multideviceMismatch:
      return { kind: 'stop', clearSession: true, error: `A sessão salva ficou inválida${suffix}. Clique em Conectar e leia o novo QR Code.` };
    case CODE.connectionReplaced:
      return { kind: 'stop', clearSession: false, error: `Esta conta foi aberta em outra janela do sistema${suffix}. Feche a outra e clique em Conectar.` };
    case CODE.forbidden:
      return { kind: 'stop', clearSession: false, error: `O WhatsApp recusou este número${suffix}. Confira no celular se há alguma restrição.` };
  }
  if (retries >= MAX_RETRIES) {
    return { kind: 'stop', clearSession: false, error: `Sem resposta do WhatsApp após ${MAX_RETRIES} tentativas${suffix}. Confira a internet deste computador e clique em Conectar.` };
  }
  return { kind: 'reconnect', delayMs: Math.min(30_000, 1000 * 2 ** retries), countsAsRetry: true };
}
