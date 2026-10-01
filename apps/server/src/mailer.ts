import type { AppConfig } from './config';

// Envio de e-mail pelo Resend (ADR-047), ligado só com RESEND_API_KEY + MAIL_FROM. É uma chamada
// HTTP simples, sem biblioteca: um POST com a chave no cabeçalho. Hoje só "esqueci minha senha"
// usa; o texto vai sem HTML, para não depender de modelo nem de imagem.

export type Mail = NonNullable<AppConfig['mail']>;
export type Message = { to: string; subject: string; text: string };

const ENDPOINT = 'https://api.resend.com/emails';

/** Manda um e-mail. Falha (serviço fora, chave recusada, demora) vira erro para quem chamou. */
export async function sendMail(mail: Mail, message: Message, fetcher: typeof fetch = fetch) {
  const response = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mail.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: mail.from, to: [message.to], subject: message.subject, text: message.text }),
    signal: AbortSignal.timeout(10_000),
  });
  // O corpo do erro pode trazer detalhes da conta do serviço: só o código vai para o log.
  if (!response.ok) throw new Error(`O serviço de e-mail recusou o envio (HTTP ${response.status}).`);
}
