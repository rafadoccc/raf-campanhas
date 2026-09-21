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
  // Só afirma o bloqueio quando tem certeza: grupo restrito E a conta encontrada sem ser admin.
  return { context, adminOnlyWithoutPermission: onlyAdmins && Boolean(self) && !self?.admin };
}
