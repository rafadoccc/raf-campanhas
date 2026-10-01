// Notas de atualização (/notas). O texto é para o CLIENTE: o que ele ganha ou percebe, em uma
// frase, sem nome de biblioteca, de arquivo ou de tela interna. Versão nova vai NO TOPO.
//
// Versão = ano.mês.sequência (26.09.3 é a terceira versão de setembro de 2026) e precisa bater
// com a data. Os itens aceitam **negrito** para abrir com um nome curto ou destacar um dado;
// use pouco (um ou dois por versão). Nada de HTML: release-notes.test.ts confere tudo isso.

export type NoteKind = 'novo' | 'melhorado' | 'desempenho' | 'corrigido' | 'seguranca' | 'removido';
export type NoteGroup = { tipo: NoteKind; itens: string[] };
export type Release = { versao: string; data: string; grupos: NoteGroup[] };

/** Ordem e rótulo dos grupos dentro de uma versão. */
export const NOTE_KINDS: { tipo: NoteKind; rotulo: string }[] = [
  { tipo: 'novo', rotulo: 'Novo' },
  { tipo: 'melhorado', rotulo: 'Melhorado' },
  { tipo: 'desempenho', rotulo: 'Desempenho' },
  { tipo: 'corrigido', rotulo: 'Corrigido' },
  { tipo: 'seguranca', rotulo: 'Segurança' },
  { tipo: 'removido', rotulo: 'Removido' },
];

export const RELEASES: Release[] = [
  {
    versao: '26.10.1',
    data: '2026-10-01',
    grupos: [
      { tipo: 'novo', itens: [
        '**Relatório da campanha:** envios, entregas, visualizações e alcance por grupo e por dia. Dá para imprimir, salvar em PDF ou mandar um link para quem não tem login.',
        '**Resumo do dia:** clique num dia do gráfico do Início para ver os números daquele dia, por hora e por campanha.',
        '**Sugestões e críticas:** no menu da sua conta, conte o que quer, o que quebrou ou o que incomoda, e acompanhe a resposta.',
      ] },
      { tipo: 'melhorado', itens: [
        'Resumo da campanha mais limpo: grupos, horários, período e duração da rodada, cada um com o seu ícone.',
        'Novo visual do nome do sistema e menu mais enxuto, com Novidades e Sair lado a lado.',
      ] },
      { tipo: 'corrigido', itens: [
        'Sair da conta enquanto outra tela atualiza não causa mais erro interno: a sessão encerrada continua encerrada.',
        'Ao desligar o sistema, as últimas gravações da conexão terminam antes de fechar o banco. Uma gravação atrasada não desfaz a desconexão.',
        'A limpeza de dados antigos usa a mesma referência de horário das campanhas e não executa duas limpezas ao mesmo tempo.',
      ] },
      { tipo: 'seguranca', itens: [
        'Excluir a conta confere novamente a senha e o papel de administrador se eles mudarem durante a confirmação, preservando os dados nesse caso.',
      ] },
    ],
  },
  {
    versao: '26.09.8',
    data: '2026-09-30',
    grupos: [
      { tipo: 'novo', itens: [
        '**Proteção do número:** regras para o WhatsApp não restringir o seu número, ajustáveis na tela WhatsApp.',
        '**Horário de silêncio:** nada sai entre 22h e 8h; o que estiver na fila espera e sai às 8h.',
        'Limite de envios por dia por número (150, ajustável) e intervalo mínimo de 2 horas antes de mandar de novo para o mesmo grupo.',
        '**Pausa automática:** se o WhatsApp der sinal de restrição, as campanhas pausam e um aviso aparece no Início.',
        '**Aquecimento de número novo:** ao conectar um chip novo, o sistema começa com 30 envios por dia e aumenta sozinho em 7 dias.',
      ] },
      { tipo: 'melhorado', itens: [
        'O intervalo entre grupos agora é sorteado entre 1 min 45 s e 3 min a cada envio, para não parecer robô. Não é mais preciso escolher.',
        'A campanha mostra por volta de que horas sai o próximo envio e quanto tempo leva cada rodada.',
      ] },
      { tipo: 'corrigido', itens: [
        'Um envio que ficava sem resposta do WhatsApp podia segurar a campanha inteira. Agora o sistema libera a fila sozinho em poucos minutos.',
      ] },
    ],
  },
  {
    versao: '26.09.7',
    data: '2026-09-30',
    grupos: [
      { tipo: 'novo', itens: [
        'O sistema agora se chama **DocDrop**.',
        'Política de Privacidade e Termos de Uso, com aceite no primeiro acesso.',
        'Em Minha conta: baixar todos os seus dados ou excluir a conta.',
      ] },
      { tipo: 'seguranca', itens: [
        'Conteúdo de campanhas encerradas é apagado depois de 6 meses, e campanhas excluídas somem de vez.',
        'Errar a senha do seu e-mail de outro lugar não bloqueia mais o seu acesso pelo seu aparelho.',
      ] },
    ],
  },
  {
    versao: '26.09.6',
    data: '2026-09-29',
    grupos: [
      { tipo: 'novo', itens: [
        '**@todos do WhatsApp:** "Marcar todos" usa o @todos de verdade, destacado na mensagem e notificando todo mundo.',
        'Prévia ao vivo da mensagem, do jeito que vai aparecer no WhatsApp, com negrito, itálico e o @todos no lugar certo.',
        'Botões para negrito, itálico, riscado e inserir @todos na caixa da mensagem.',
      ] },
      { tipo: 'melhorado', itens: [
        'Animações curtas e discretas ao abrir telas e janelas.',
      ] },
    ],
  },
  {
    versao: '26.09.5',
    data: '2026-09-28',
    grupos: [
      { tipo: 'melhorado', itens: [
        'O WhatsApp continua conectado depois de quedas e atualizações do sistema, sem pedir o QR de novo.',
        'Painel ajustado para celular, tablet e computador.',
      ] },
      { tipo: 'corrigido', itens: [
        'No celular, a tela inicial travava a rolagem para cima.',
        'O painel volta para o login quando a sessão acaba, sem mostrar dados antigos.',
      ] },
      { tipo: 'seguranca', itens: [
        'Proteções extras no login, nas senhas e no envio de arquivos.',
      ] },
    ],
  },
  {
    versao: '26.09.4',
    data: '2026-09-27',
    grupos: [
      { tipo: 'novo', itens: [
        'Os grupos sincronizam sozinhos assim que o WhatsApp conecta.',
        'Menu da conta com "Alterar senha".',
      ] },
      { tipo: 'melhorado', itens: [
        'O primeiro envio sai assim que a campanha é iniciada.',
        '"Atrasado" só aparece quando o envio realmente atrasou.',
        'O modelo da mensagem fica recolhido na campanha e abre com um clique.',
        'Tela de Administração organizada em blocos.',
      ] },
      { tipo: 'desempenho', itens: [
        'Troca de telas instantânea e menos espera para carregar.',
      ] },
      { tipo: 'removido', itens: [
        'Modo de simulação: toda campanha agora envia de verdade.',
        'Excluir campanha de dentro dela; continua disponível na lista de campanhas.',
      ] },
    ],
  },
  {
    versao: '26.09.3',
    data: '2026-09-24',
    grupos: [
      { tipo: 'novo', itens: [
        '**Cada conta com o seu WhatsApp:** cada usuário conecta o próprio número e vê só as próprias campanhas.',
        '"Usar de novo" para repetir uma campanha e filtro por situação e nome.',
        'Marcar todos os membros do grupo e tentar de novo um envio que falhou.',
        'Vídeos do celular (inclusive do iPhone) são convertidos sozinhos para o formato do WhatsApp.',
        'Painel do administrador com as contas e os números do sistema.',
      ] },
      { tipo: 'melhorado', itens: [
        'Visual novo em todas as telas.',
      ] },
      { tipo: 'desempenho', itens: [
        'Números diferentes enviam ao mesmo tempo, sem um esperar o outro.',
      ] },
    ],
  },
  {
    versao: '26.09.2',
    data: '2026-09-22',
    grupos: [
      { tipo: 'novo', itens: [
        'Previsão de horário de cada envio da campanha.',
        'Entregues e visualizações por grupo, com o número de membros.',
      ] },
      { tipo: 'melhorado', itens: [
        'O que comprovadamente não saiu é reenviado sozinho, até 3 vezes.',
        'Lista de campanhas em blocos, com o progresso e o motivo de cada espera.',
      ] },
    ],
  },
  {
    versao: '26.09.1',
    data: '2026-09-21',
    grupos: [
      { tipo: 'novo', itens: [
        'Primeira versão: conecte o WhatsApp pelo QR Code e programe campanhas para os seus grupos.',
        'Busca de grupos pelo nome ao montar a campanha.',
        'Cada envio mostra se foi entregue, recusado ou se ainda aguarda confirmação.',
        'Selo nos grupos em que só administradores podem enviar.',
      ] },
      { tipo: 'seguranca', itens: [
        'Acesso só com login e senha.',
      ] },
    ],
  },
];

/** Versão no ar (a mais nova). */
export const LATEST_RELEASE = RELEASES[0].versao;

/** Partes de um item: texto comum e trechos em **negrito**. */
export function noteParts(item: string): { text: string; bold: boolean }[] {
  return item.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(part =>
    part.startsWith('**') && part.endsWith('**') ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false });
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** "30 de setembro de 2026" (a data é só o dia, sem fuso). */
export function dataPorExtenso(data: string) {
  const [ano, mes, dia] = data.split('-').map(Number);
  return `${dia} de ${MESES[mes - 1]} de ${ano}`;
}
