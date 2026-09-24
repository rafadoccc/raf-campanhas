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
