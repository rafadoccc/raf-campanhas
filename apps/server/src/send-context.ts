// Situação do grupo no momento do envio, gravada em Delivery.sendContext (ADR-012). Serve
// para explicar depois por que uma mensagem foi recusada — por exemplo, grupo em que só
// administradores podem enviar e a conta não é administradora.

type Participant = { id: string; lid?: string; phoneNumber?: string; admin?: 'admin' | 'superadmin' | null };
type GroupInfo = { announce?: boolean; isCommunityAnnounce?: boolean; size?: number; participants?: Participant[] };

// "5511999999999:12@s.whatsapp.net" e "5511999999999@s.whatsapp.net" são o mesmo usuário.
const userOf = (jid?: string | null) => (jid ? jid.split('@')[0].split(':')[0] : '');

export function describeGroupForSend(group: GroupInfo, me: { id?: string; lid?: string }) {
  const mine = new Set([userOf(me.id), userOf(me.lid)].filter(Boolean));
  // O WhatsApp pode listar participantes pelo LID em vez do número: se a conta não for
  // encontrada, a situação fica "?" (desconhecida), nunca "não".
  const self = (group.participants ?? []).find(p => [p.id, p.lid, p.phoneNumber].some(jid => mine.has(userOf(jid))));
  const onlyAdmins = Boolean(group.announce || group.isCommunityAnnounce);
  const yesNo = (value: boolean) => (value ? 'sim' : 'nao');
  const context = [
    `membro=${self ? 'sim' : '?'}`,
    `admin=${self ? yesNo(Boolean(self.admin)) : '?'}`,
    `so-admins=${yesNo(onlyAdmins)}`,
    `participantes=${group.size ?? group.participants?.length ?? '?'}`,
  ].join(' ');
  // isAdmin: null quando a conta não foi encontrada (desconhecido, nunca "não").
  const isAdmin = self ? Boolean(self.admin) : null;
  const participants = group.size ?? group.participants?.length ?? null;
  // Só afirma o bloqueio quando tem certeza: grupo restrito E a conta encontrada sem ser admin.
  return { context, onlyAdmins, isAdmin, participants, adminOnlyWithoutPermission: onlyAdmins && isAdmin === false };
}

/**
 * Membros a marcar no "marcar todos" (ADR-029): todos os participantes do grupo, exceto a
 * própria conta. Usa o id que o WhatsApp informa (número ou LID), sem converter.
 */
export function mentionTargets(group: GroupInfo, me: { id?: string; lid?: string }) {
  const mine = new Set([userOf(me.id), userOf(me.lid)].filter(Boolean));
  const ids = (group.participants ?? [])
    .filter(p => ![p.id, p.lid, p.phoneNumber].some(jid => mine.has(userOf(jid))))
    .map(p => p.id)
    .filter((id): id is string => typeof id === 'string' && id.includes('@'));
  return [...new Set(ids)];
}

// ─── @todos nativo do WhatsApp (ADR-039) ────────────────────────────────────────
// O @todos que o celular cria (digitar "@" e tocar em "todos") não lista ninguém: vai no texto
// um marcador e, no contextInfo, nonJidMentions = 1. Todos os membros recebem a notificação, até
// quem silenciou o grupo, e o marcador aparece destacado. Regra do WhatsApp: em grupo com mais de
// 32 membros, só administradores podem usar. Fora dessa regra, o sistema usa a marcação oculta
// antiga (ADR-029), que também notifica, só sem o destaque.

/** Acima disso, só administradores do grupo podem usar o @todos nativo. */
export const MENTION_ALL_OPEN_LIMIT = 32;
/** Marcador enviado no texto. O que o celular grava confirma ou troca este padrão (captura). */
export const DEFAULT_MENTION_ALL_TOKEN = '@all';

/** 'native' = @todos do WhatsApp; 'hidden' = marcação oculta de cada membro (compatível sempre). */
export function mentionAllMode(group: { participants: number | null; isAdmin: boolean | null }): 'native' | 'hidden' {
  if (group.isAdmin === true) return 'native';
  return group.participants !== null && group.participants <= MENTION_ALL_OPEN_LIMIT ? 'native' : 'hidden';
}

// "@todos", "@all" ou "@everyone" digitados pelo usuário no texto da campanha.
const MENTION_ALL_WORD = /(^|[\s(])@(todos|all|everyone)(?![\p{L}\p{N}_])/iu;

/**
 * Texto com o marcador do @todos: onde o usuário escreveu "@todos" (ou "@all"), fica ali; se não
 * escreveu, entra no começo. Nunca repete o marcador.
 */
export function withMentionAllToken(text: string, token = DEFAULT_MENTION_ALL_TOKEN) {
  if (MENTION_ALL_WORD.test(text)) return text.replace(MENTION_ALL_WORD, (_match, lead: string) => `${lead}${token}`);
  return text ? `${token} ${text}` : token;
}

/**
 * Do que o celular mandou num @todos de verdade, guarda só o formato (nunca o texto): as palavras
 * logo depois de "@" que não são números, e os campos de menção. Serve para confirmar o marcador.
 */
export function mentionAllSample(text: string, contextInfo: { nonJidMentions?: number | null; mentionedJid?: string[] | null }) {
  const tokens = [...new Set([...text.matchAll(/@([\p{L}_][\p{L}\p{N}_]{0,20})/gu)].map(m => `@${m[1]}`))];
  return { nonJidMentions: contextInfo.nonJidMentions ?? null, mentionedJidCount: contextInfo.mentionedJid?.length ?? 0, tokens };
}

// Falha antes de o sendMessage ser chamado: nada saiu, então o envio pode ser tentado de novo
// (ADR-014). Qualquer falha sem esta marca é tratada como resultado incerto.
export function notSent(error: unknown): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  return Object.assign(e, { notSent: true });
}
export const isNotSent = (error: unknown) => (error as { notSent?: unknown } | null)?.notSent === true;

/**
 * Um FAILED é "incerto" quando não se sabe se a mensagem chegou (ADR-014/030): a palavra
 * "incerto" na mensagem de erro é a única marca (posta pelo despachante e pela recuperação na
 * partida) — assim não existe uma segunda fonte de verdade para esta classificação, que teria
 * que ser mantida em sincronia com o texto do erro. Falhas certas (nada saiu, ou reenvio
 * automático esgotado) nunca levam a palavra. Usado para decidir se "tentar de novo" pode
 * seguir direto ou precisa de confirmação explícita (risco de duplicar o envio).
 */
export const isUncertainFailure = (error?: string | null) => Boolean(error?.toLowerCase().includes('incerto'));
