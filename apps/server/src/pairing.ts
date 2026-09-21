import { randomBytes } from 'node:crypto';

// Correção do pareamento por QR para o Baileys 7.0.0-rc14.
//
// Desde ~28/07/2026 o WhatsApp envia <notification type="companion_reg_refresh"> depois
// que o celular lê o QR, aposentando o "adv secret" que o QR anuncia. O Baileys confirma
// a notificação e a descarta: o QR continua anunciando o segredo antigo, o celular diz
// "não foi possível conectar o dispositivo" e o pareamento nunca termina.
//
// A resposta esperada (a mesma do WhatsApp Web) é gerar um adv secret novo e redesenhar
// o QR que está na tela com ele. Esta é a lógica do PR WhiskeySockets/Baileys#2765, ainda
// não publicado em nenhuma versão, aplicada aqui fora do node_modules para sobreviver a
// reinstalações. Remova quando uma versão oficial do Baileys tratar a notificação.
// Ref.: https://github.com/WhiskeySockets/Baileys/issues/2737

type BinaryNode = { tag: string; attrs: Record<string, string>; content?: unknown };
type PairingCreds = { advSecretKey: string; me?: unknown };
export type RefreshOutcome = 'rotated' | 'ignored_malformed' | 'ignored_registered';

// Filhos que o WhatsApp Web aceita nesta notificação.
const REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'];

export function handleCompanionRegRefresh(node: BinaryNode, creds: PairingCreds, newSecret = () => randomBytes(32).toString('base64')): RefreshOutcome {
  const children = Array.isArray(node.content) ? node.content as BinaryNode[] : [];
  if (!children.some(child => REFRESH_CHILDREN.includes(child?.tag))) return 'ignored_malformed';
  // Sessão já pareada: o adv secret é o que valida o pareamento. Trocá-lo quebraria a sessão.
  if (creds.me) return 'ignored_registered';
  creds.advSecretKey = newSecret();
  return 'rotated';
}

// O conteúdo do QR é "ref,noiseKey,identityKey,advSecret,plataforma". O Baileys rc14
// captura o advSecret uma única vez; aqui o QR é sempre reescrito com o valor atual.
export function withAdvSecret(qr: string, advSecretKey: string) {
  const parts = qr.split(',');
  if (parts.length !== 5 || !advSecretKey) return qr;
  parts[3] = advSecretKey;
  return parts.join(',');
}
