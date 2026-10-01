import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { IconBack, Logo } from '../design';

// Política de Privacidade e Termos de Uso (LGPD, ADR-040). Páginas públicas: abrem sem login,
// pelo link da tela de entrada. Mudou algo relevante no texto? Troque TERMS_VERSION no servidor
// (auth.ts) e a data de atualização abaixo: todos aceitam de novo no próximo acesso.

const UPDATED_AT = '30 de setembro de 2026';

type LegalInfo = { product: string; contactEmail: string | null; retentionDays: number };

function useLegalInfo() {
  const [info, setInfo] = useState<LegalInfo>({ product: 'DocDrop', contactEmail: null, retentionDays: 180 });
  useEffect(() => { api<LegalInfo>('/legal').then(setInfo).catch(() => undefined); }, []);
  return info;
}

function Contact({ email }: { email: string | null }) {
  return email
    ? <a className="font-medium text-brand-700 underline" href={`mailto:${email}`}>{email}</a>
    : <span className="font-medium">o e-mail de contato informado pelo DocDrop</span>;
}

type Section = { title: string; body: ReactNode };

function privacySections({ contactEmail, retentionDays }: LegalInfo): Section[] {
  const months = Math.round(retentionDays / 30);
  return [
    { title: '1. Quem somos', body: <>
      <p>O DocDrop é um painel para programar e enviar mensagens em grupos de WhatsApp dos próprios clientes. Ele é mantido por pessoa física, que responde pelo tratamento dos dados descritos aqui.</p>
      <p>Em relação aos <strong>dados da sua conta</strong> (nome, e-mail, acessos), o DocDrop é o <strong>controlador</strong>. Em relação ao <strong>conteúdo das campanhas</strong> e aos <strong>grupos</strong> que você usa, quem decide o que é enviado e para quem é você, cliente: nesse caso o DocDrop é o <strong>operador</strong> e trata esses dados apenas para executar os envios que você programou.</p>
      <p>Contato para qualquer assunto de privacidade: <Contact email={contactEmail} />.</p>
    </> },
    { title: '2. Quais dados tratamos', body: <ul className="list-disc space-y-1 pl-5">
      <li><strong>Conta:</strong> nome, e-mail, senha (guardada cifrada, de forma que nem nós conseguimos lê-la) e a data em que você aceitou estes termos.</li>
      <li><strong>Acessos:</strong> endereço IP, navegador e horário de cada login, enquanto a sessão estiver aberta.</li>
      <li><strong>WhatsApp conectado:</strong> o número conectado e as chaves de conexão, guardadas no servidor e nunca exibidas.</li>
      <li><strong>Grupos:</strong> nome, identificador, número de membros e se você é administrador de cada grupo.</li>
      <li><strong>Campanhas:</strong> textos, imagens e vídeos que você envia, horários, e o histórico de cada envio (enviado, entregue, falhou).</li>
      <li><strong>Leituras:</strong> quantas pessoas leram cada mensagem. O número de telefone de quem leu é transformado em um código (hash) e usado só para contar; não guardamos a lista de quem leu.</li>
      <li><strong>Membros dos grupos:</strong> não guardamos a lista de membros. Ela é consultada no WhatsApp apenas no momento do envio, quando a opção "Marcar todos" está ligada.</li>
    </ul> },
    { title: '3. Para que usamos e com qual base legal', body: <ul className="list-disc space-y-1 pl-5">
      <li><strong>Prestar o serviço</strong> (criar sua conta, conectar o WhatsApp, programar e enviar campanhas, mostrar relatórios): execução de contrato (LGPD, art. 7º, V).</li>
      <li><strong>Segurança</strong> (limitar tentativas de login, registrar acessos, investigar abuso): legítimo interesse (art. 7º, IX) e proteção do próprio serviço.</li>
      <li><strong>Cumprir obrigações legais</strong> ou ordens de autoridades, quando existirem (art. 7º, II).</li>
      <li>Os dados das campanhas e dos grupos são tratados <strong>em nome do cliente</strong>. Cabe ao cliente ter base legal para enviar mensagens aos grupos que escolhe.</li>
    </ul> },
    { title: '4. Com quem compartilhamos', body: <>
      <p>Não vendemos nem alugamos dados. Eles passam apenas por:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li><strong>Empresa de hospedagem</strong> onde o sistema funciona (servidor e banco de dados), que só armazena e processa os dados para nós.</li>
        <li><strong>WhatsApp (Meta)</strong>, pelo qual as mensagens são enviadas, conforme as regras do próprio WhatsApp.</li>
        <li><strong>Autoridades</strong>, somente quando houver obrigação legal ou ordem judicial.</li>
      </ul>
      <p>Os servidores podem ficar no Brasil ou no exterior. Quando ficarem fora do Brasil, a transferência segue o art. 33 da LGPD, com provedores que adotam medidas de segurança compatíveis.</p>
    </> },
    { title: '5. Por quanto tempo guardamos', body: <ul className="list-disc space-y-1 pl-5">
      <li><strong>Conta:</strong> enquanto ela existir.</li>
      <li><strong>Campanhas encerradas ou concluídas</strong> (mensagens, mídias, histórico de envios e leituras): apagadas automaticamente {months} meses depois da última atividade.</li>
      <li><strong>Campanhas que você exclui:</strong> apagadas de vez em até 24 horas.</li>
      <li><strong>Mídias enviadas que não entraram em nenhuma campanha:</strong> apagadas depois de 1 dia.</li>
      <li><strong>Grupos que saíram do seu WhatsApp:</strong> apagados {months} meses depois, se não estiverem em nenhuma campanha.</li>
      <li><strong>Registros de acesso:</strong> até a sessão expirar (no máximo 30 dias).</li>
      <li><strong>Cópias de segurança:</strong> substituídas em até 7 dias; o que foi apagado some delas nesse prazo.</li>
      <li>Ao <strong>excluir a conta</strong>, tudo é apagado na hora, inclusive a conexão do WhatsApp.</li>
    </ul> },
    { title: '6. Como protegemos', body: <p>Conexão sempre cifrada (HTTPS), senhas cifradas, cada conta só acessa os próprios dados, cookie de sessão protegido contra leitura por scripts, limite de tentativas de login e registro de acessos. Nenhum sistema é 100% seguro; se acontecer um incidente que possa causar risco ou dano relevante, avisaremos os afetados e a Autoridade Nacional de Proteção de Dados (ANPD) nos prazos da lei.</p> },
    { title: '7. Cookies', body: <p>Usamos <strong>um único cookie</strong>, essencial, que mantém você conectado ao painel. Não usamos cookies de publicidade, de rastreamento nem ferramentas de análise de terceiros. Por isso não há aviso de consentimento de cookies.</p> },
    { title: '8. Seus direitos', body: <>
      <p>Pela LGPD (art. 18) você pode, a qualquer momento: confirmar se tratamos seus dados, acessá-los, corrigi-los, pedir a portabilidade, pedir a exclusão, saber com quem foram compartilhados e revogar consentimentos.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li><strong>Baixar seus dados</strong> e <strong>excluir sua conta</strong>: direto em <em>Minha conta</em>, no painel.</li>
        <li><strong>Corrigir</strong> nome ou e-mail e os demais pedidos: pelo e-mail <Contact email={contactEmail} />. Respondemos em até 15 dias.</li>
        <li><strong>Membros de grupos</strong> que receberam mensagens: podem falar conosco pelo mesmo e-mail. Como o conteúdo pertence ao cliente que fez o envio, encaminharemos o pedido a ele.</li>
        <li>Você também pode reclamar à ANPD (gov.br/anpd).</li>
      </ul>
    </> },
    { title: '9. Idade', body: <p>O DocDrop é destinado a maiores de 18 anos.</p> },
    { title: '10. Alterações', body: <p>Se esta política mudar de forma relevante, o painel pedirá que você leia e aceite a nova versão no próximo acesso.</p> },
  ];
}

function termsSections({ contactEmail, retentionDays }: LegalInfo): Section[] {
  const months = Math.round(retentionDays / 30);
  return [
    { title: '1. O serviço', body: <p>O DocDrop permite conectar o seu WhatsApp e programar o envio de mensagens, imagens e vídeos para grupos dos quais você participa. Ao criar uma conta ou usar o painel, você concorda com estes Termos e com a <Link className="text-brand-700 underline" to="/privacidade">Política de Privacidade</Link>.</p> },
    { title: '2. Sua conta', body: <ul className="list-disc space-y-1 pl-5">
      <li>Você precisa ter 18 anos ou mais e informar dados verdadeiros.</li>
      <li>A senha é pessoal. Você responde pelo que for feito com a sua conta; se suspeitar de acesso indevido, troque a senha e nos avise.</li>
    </ul> },
    { title: '3. Uso permitido', body: <>
      <p>Você só pode enviar mensagens para grupos em que <strong>tenha autorização</strong> para divulgar. É proibido usar o DocDrop para:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>spam, correntes, golpes, conteúdo enganoso ou envio para quem pediu para não receber;</li>
        <li>conteúdo ilegal, discriminatório, violento, que viole direitos de terceiros ou direitos autorais;</li>
        <li>divulgar bebidas alcoólicas ou eventos de forma dirigida a menores de idade;</li>
        <li>coletar ou usar dados de membros dos grupos sem base legal.</li>
      </ul>
      <p>Você deve respeitar também as regras de cada grupo e os termos do WhatsApp.</p>
    </> },
    { title: '4. WhatsApp: conexão não oficial e risco de bloqueio', body: <>
      <p>O DocDrop <strong>não é afiliado ao WhatsApp nem à Meta</strong>. A conexão usa o mesmo mecanismo do "WhatsApp Web", por meio de software não oficial. O WhatsApp pode <strong>restringir ou banir números</strong> que considere automatizados ou que recebam denúncias.</p>
      <p>O sistema adota intervalos entre envios para reduzir esse risco, mas não há garantia. <strong>Você assume o risco</strong> de restrição do número conectado, e o DocDrop não responde por bloqueios, perda de acesso ao número ou mensagens não entregues por decisão do WhatsApp.</p>
    </> },
    { title: '5. Dados pessoais nas campanhas', body: <>
      <p>Nas campanhas, <strong>você é o controlador</strong> dos dados dos grupos e de seus membros, e o DocDrop atua como <strong>operador</strong>. Isso significa que:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>você garante ter base legal (por exemplo, a participação voluntária dos membros num grupo de divulgação) para enviar as mensagens;</li>
        <li>o DocDrop trata esses dados só para executar os envios que você programou, nunca para fins próprios, e os mantém em sigilo;</li>
        <li>o DocDrop adota medidas de segurança, avisa você sobre incidentes que afetem os seus dados e apaga o conteúdo das campanhas em {months} meses após o encerramento ou quando você excluir a conta;</li>
        <li>a hospedagem do sistema é o único suboperador.</li>
      </ul>
    </> },
    { title: '6. Seu conteúdo', body: <p>Os textos, imagens e vídeos continuam sendo seus. Você autoriza o DocDrop apenas a guardá-los e enviá-los conforme as campanhas que criar, e garante ter os direitos sobre eles.</p> },
    { title: '7. Disponibilidade', body: <p>Fazemos o possível para manter o serviço funcionando, mas ele pode ficar indisponível por manutenção, falhas de internet, do servidor ou do WhatsApp. Envios podem atrasar ou falhar; o painel mostra a situação de cada um.</p> },
    { title: '8. Responsabilidade', body: <p>O DocDrop não responde pelo conteúdo das mensagens enviadas pelos clientes, por decisões do WhatsApp nem por danos indiretos, como lucros cessantes. Nada nestes Termos afasta direitos garantidos pelo Código de Defesa do Consumidor.</p> },
    { title: '9. Suspensão e encerramento', body: <p>Podemos suspender ou encerrar contas que violem estes Termos, com aviso sempre que possível. Você pode excluir sua conta quando quiser, em <em>Minha conta</em>.</p> },
    { title: '10. Preço e pagamento', body: <p>Valores, formas de pagamento e prazos são combinados diretamente com o DocDrop, fora do painel.</p> },
    { title: '11. Alterações e contato', body: <p>Mudanças relevantes nestes Termos serão apresentadas no painel para um novo aceite. Dúvidas: <Contact email={contactEmail} />. Aplicam-se as leis brasileiras; fica eleito o foro do domicílio do cliente.</p> },
  ];
}

export default function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const info = useLegalInfo();
  const { user } = useAuth();
  const privacy = kind === 'privacy';
  const sections = privacy ? privacySections(info) : termsSections(info);
  useEffect(() => { document.title = `${privacy ? 'Privacidade' : 'Termos de Uso'} · DocDrop`; return () => { document.title = 'DocDrop'; }; }, [privacy]);
  return <div className="h-dvh overflow-y-auto bg-slate-50">
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <Link to={user ? '/' : '/login'} className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <IconBack className="h-4 w-4" aria-hidden />{user ? 'Voltar ao painel' : 'Voltar para a entrada'}
      </Link>
      <article className="space-y-6 rounded-lg border border-line bg-white p-5 shadow-card sm:p-8">
        <header className="space-y-1">
          <Logo className="mb-2 text-base" />
          <h1 className="text-xl font-semibold leading-tight">{privacy ? 'Política de Privacidade' : 'Termos de Uso'}</h1>
          <p className="text-xs text-muted">Atualizado em {UPDATED_AT}.</p>
        </header>
        {sections.map(section => <section key={section.title} className="space-y-2 text-sm leading-relaxed text-ink">
          <h2 className="text-base font-semibold">{section.title}</h2>
          {section.body}
        </section>)}
        <footer className="border-t border-line pt-4 text-sm">
          {privacy
            ? <Link className="text-brand-700 underline" to="/termos">Ler os Termos de Uso</Link>
            : <Link className="text-brand-700 underline" to="/privacidade">Ler a Política de Privacidade</Link>}
        </footer>
      </article>
    </main>
  </div>;
}
