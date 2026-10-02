import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Doodle, DoodleDefs, type DoodleName } from '../components/doodles';
import { Logo } from '../design';

// Página de apresentação (/conheca): a porta de entrada pública do DocDrop, para um público jovem
// (donos e promoters de festa). Visual de caderno rabiscado: desenhos à mão ao fundo, títulos em
// letra manuscrita e um marca-texto amarelo. Só aqui: o painel continua limpo e neutro.
// EXEMPLO para o dono aprovar o estilo; os textos e os desenhos são um ponto de partida.

// Rabiscos soltos ao fundo: posição em %, tamanho e giro. Clarinhos, para não brigar com o texto.
const BACKDROP: { name: DoodleName; top: string; left: string; size: string; turn: number }[] = [
  { name: 'globo', top: '4%', left: '4%', size: '9rem', turn: -8 },
  { name: 'sorriso', top: '10%', left: '78%', size: '11rem', turn: 10 },
  { name: 'estrela', top: '30%', left: '90%', size: '5rem', turn: 18 },
  { name: 'raio', top: '34%', left: '2%', size: '6rem', turn: -14 },
  { name: 'megafone', top: '52%', left: '82%', size: '10rem', turn: -6 },
  { name: 'coracao', top: '62%', left: '6%', size: '7rem', turn: 12 },
  { name: 'lua', top: '80%', left: '86%', size: '8rem', turn: 6 },
  { name: 'celular', top: '86%', left: '10%', size: '9rem', turn: -10 },
];

const STEPS: { doodle: DoodleName; title: string; text: string }[] = [
  { doodle: 'celular', title: 'Conecta o zap', text: 'Lê o QR Code uma vez, igual ao WhatsApp Web. Seus grupos aparecem sozinhos.' },
  { doodle: 'megafone', title: 'Monta a campanha', text: 'Flyer, texto, grupos e horários. Salva como modelo e usa de novo na próxima festa.' },
  { doodle: 'grafico', title: 'Acompanha o rolê', text: 'Vê o que já saiu, o que foi entregue e quantas pessoas visualizaram, grupo por grupo.' },
];

const FEATURES: { doodle: DoodleName; title: string; text: string }[] = [
  { doodle: 'lua', title: 'Não acorda ninguém', text: 'De noite fica em silêncio e volta de manhã, sozinho.' },
  { doodle: 'raio', title: 'Cuida do seu número', text: 'Intervalo que varia, limite por dia e pausa se o WhatsApp reclamar.' },
  { doodle: 'estrela', title: '@todos de verdade', text: 'Marca o grupo inteiro: até quem silenciou recebe a notificação.' },
  { doodle: 'seta', title: 'Relatório pra mostrar', text: 'Um link com os números da campanha para mandar a quem contratou.' },
];

const WORDS = ['sexta universitária', 'open bar', 'lista vip', 'último lote', 'aniversariante não paga', 'esquenta', 'after', 'virada de lote', 'nome na lista', 'halloween', 'sunset'];

/** Marca-texto amarelo por trás de um trecho do título. */
const Mark = ({ children }: { children: string }) => <span className="relative inline-block whitespace-nowrap"><span aria-hidden className="absolute inset-x-[-0.15em] bottom-[0.08em] top-[45%] -rotate-1 rounded-sm bg-yellow-300" /><span className="relative">{children}</span></span>;

export default function LandingPage() {
  const [contact, setContact] = useState<string | null>(null);
  useEffect(() => { api<{ contactEmail: string | null }>('/legal').then(data => setContact(data.contactEmail)).catch(() => undefined); }, []);
  useEffect(() => { document.title = 'DocDrop · Seu flyer em todos os grupos'; }, []);
  const cta = 'inline-flex h-12 items-center justify-center rounded border-2 border-ink px-6 text-base font-semibold transition-transform hover:-translate-y-0.5 hover:rotate-[-1deg] active:translate-y-0';

  return <div className="relative h-dvh overflow-y-auto overflow-x-hidden bg-white text-ink">
    <DoodleDefs />
    <div className="relative isolate">
      {/* Fundo rabiscado: acompanha a página inteira e fica atrás do conteúdo. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden text-slate-200">
        {BACKDROP.map(item => <Doodle key={item.name} name={item.name} className="absolute animate-doodle-float" style={{ top: item.top, left: item.left, width: item.size, height: item.size, rotate: `${item.turn}deg` }} />)}
      </div>
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Logo className="text-xl" />
        <Link to="/login" className="font-hand text-base underline decoration-2 underline-offset-4 hover:decoration-yellow-400">entrar</Link>
      </header>

      <main className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <section className="flex flex-col items-center pb-16 pt-10 text-center sm:pb-24 sm:pt-16">
          <p className="font-hand text-sm text-muted sm:text-base">para quem vive de festa</p>
          <h1 className="mt-3 max-w-3xl font-hand text-4xl font-bold leading-[1.15] sm:text-6xl sm:leading-[1.1]">
            Seu flyer em <Mark>todos os grupos</Mark>, sem copiar e colar.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted">
            O DocDrop manda a divulgação da sua festa para os seus grupos de WhatsApp na hora certa, cuida do seu número e mostra quem recebeu.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {contact
              ? <a href={`mailto:${contact}?subject=${encodeURIComponent('Quero usar o DocDrop')}`} className={`${cta} bg-ink text-white`}>Quero usar</a>
              : <Link to="/login" className={`${cta} bg-ink text-white`}>Entrar no painel</Link>}
            <a href="#como-funciona" className={`${cta} bg-white`}>Ver como funciona</a>
          </div>
          <Doodle name="seta" className="mt-10 h-16 w-16 rotate-90 text-ink" />
        </section>

        <section id="como-funciona" className="scroll-mt-6 pb-16 sm:pb-24">
          <h2 className="text-center font-hand text-2xl font-bold sm:text-4xl">Três passos e <Mark>tá no ar</Mark></h2>
          <ol className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {STEPS.map((step, i) => <li key={step.title} className="group relative rounded-lg border-2 border-ink bg-white p-6 transition-transform hover:-translate-y-1" style={{ rotate: `${[-1.2, 0.8, -0.6][i]}deg` }}>
              <span className="absolute -left-3 -top-3 grid h-9 w-9 place-items-center rounded-full border-2 border-ink bg-yellow-300 font-hand text-base font-bold">{i + 1}</span>
              <Doodle name={step.doodle} className="h-20 w-20 text-ink group-hover:animate-doodle-wiggle" />
              <h3 className="mt-4 font-hand text-xl font-bold">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.text}</p>
            </li>)}
          </ol>
        </section>
      </main>

      {/* Faixa correndo: o vocabulário de quem divulga festa. */}
      <div aria-hidden className="overflow-hidden border-y-2 border-ink bg-yellow-300 py-3">
        <div className="flex w-max animate-doodle-marquee gap-8 font-hand text-base font-bold">
          {[...WORDS, ...WORDS].map((word, i) => <span key={i} className="flex items-center gap-8 whitespace-nowrap">{word}<Doodle name="estrela" className="h-4 w-4" /></span>)}
        </div>
      </div>

      <main className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <section className="py-16 sm:py-24">
          <h2 className="text-center font-hand text-2xl font-bold sm:text-4xl">O que ele faz <Mark>por você</Mark></h2>
          <ul className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
            {FEATURES.map(feature => <li key={feature.title} className="group flex items-start gap-4">
              <Doodle name={feature.doodle} className="h-14 w-14 shrink-0 text-ink group-hover:animate-doodle-wiggle" />
              <div>
                <h3 className="font-hand text-lg font-bold">{feature.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{feature.text}</p>
              </div>
            </li>)}
          </ul>
        </section>

        <section className="mb-16 flex flex-col items-center rounded-lg border-2 border-ink bg-white px-6 py-12 text-center sm:mb-24">
          <Doodle name="sorriso" className="h-20 w-20 text-ink" />
          <h2 className="mt-4 font-hand text-2xl font-bold sm:text-4xl">Bora lotar a próxima?</h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">O acesso é liberado por convite. Fale com a gente e conecte o seu WhatsApp em poucos minutos.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {contact && <a href={`mailto:${contact}?subject=${encodeURIComponent('Quero usar o DocDrop')}`} className={`${cta} bg-ink text-white`}>Quero usar</a>}
            <Link to="/login" className={`${cta} ${contact ? 'bg-white' : 'bg-ink text-white'}`}>Já tenho conta</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line px-5 py-6 text-center text-xs text-muted">
        <Logo className="text-sm" />
        <p className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <Link to="/notas" className="hover:text-ink hover:underline">Novidades</Link>
          <Link to="/termos" className="hover:text-ink hover:underline">Termos de Uso</Link>
          <Link to="/privacidade" className="hover:text-ink hover:underline">Privacidade</Link>
        </p>
        <p className="mt-2 text-2xs text-slate-400">O DocDrop não é afiliado ao WhatsApp nem à Meta.</p>
      </footer>
    </div>
  </div>;
}
