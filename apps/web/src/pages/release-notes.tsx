import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { LATEST_RELEASE, NOTE_KINDS, RELEASES, dataPorExtenso, noteParts, type NoteKind } from '../lib/release-notes';
import { markReleaseNotesSeen } from '../lib/release-notes-seen';
import { IconBack, IconOpen } from '../design';

// Notas de atualização (/notas). Página de LEITURA, fora da moldura do painel: a data e o número
// da versão à esquerda, o que mudou à direita. O texto vive em lib/release-notes.ts.

const PAGE_SIZE = 5;
const rotulo = Object.fromEntries(NOTE_KINDS.map(k => [k.tipo, k.rotulo])) as Record<NoteKind, string>;
// Cor só na etiqueta, que já diz o tipo; o texto do item fica na cor normal.
const tagClass: Record<NoteKind, string> = {
  novo: 'bg-emerald-100 text-emerald-800',
  melhorado: 'bg-amber-100 text-amber-800',
  desempenho: 'bg-blue-100 text-blue-800',
  corrigido: 'bg-slate-200 text-slate-700',
  seguranca: 'bg-red-100 text-red-800',
  removido: 'bg-gray-200 text-gray-600',
};
const pageLink = 'inline-flex items-center justify-center gap-1.5 rounded border border-line px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-brand-500 hover:bg-brand-50';

export default function ReleaseNotesPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const scroller = useRef<HTMLDivElement>(null);
  const totalPages = Math.max(1, Math.ceil(RELEASES.length / PAGE_SIZE));
  // ?pagina=2 na URL: cada página tem endereço próprio e entra no histórico do navegador.
  const page = Math.min(totalPages, Math.max(1, Number(params.get('pagina')) || 1));
  const releases = RELEASES.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => { document.title = 'Notas de atualização · DocDrop'; markReleaseNotesSeen(); return () => { document.title = 'DocDrop'; }; }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [page]);

  return <div ref={scroller} className="h-dvh overflow-y-auto bg-white text-ink">
    <header className="sticky top-0 z-10 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-3.5 sm:px-7">
        <Link to={user ? '/' : '/login'} className="group inline-flex items-center gap-1.5 py-1.5 pr-2 text-sm font-medium text-muted transition-colors hover:text-ink">
          <IconBack className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" aria-hidden />{user ? 'Voltar ao painel' : 'Voltar para a entrada'}
        </Link>
        <span className="select-none text-sm text-muted">DocDrop</span>
      </div>
    </header>

    <main className="mx-auto w-full max-w-3xl animate-fade-in px-5 pb-16 pt-2 sm:px-7">
      <h1 className="text-2xl font-bold tracking-tight">Notas de atualização</h1>

      {releases.map((release, index) => <article key={release.versao} className="grid grid-cols-1 gap-3.5 border-t border-line py-7 first-of-type:border-t-0 first-of-type:pt-6 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6 sm:py-8">
        <aside className="flex flex-wrap items-center gap-x-2.5 gap-y-1 sm:sticky sm:top-16 sm:flex-col sm:items-start sm:self-start">
          <time dateTime={release.data} className="whitespace-nowrap text-2xs font-semibold uppercase tracking-wider text-muted">{dataPorExtenso(release.data)}</time>
          <span className="tabular inline-flex items-center gap-1.5 text-sm font-semibold">
            v{release.versao}
            {/* Só a primeira da primeira página: é a versão no ar (LATEST_RELEASE). */}
            {page === 1 && index === 0 && release.versao === LATEST_RELEASE && <span role="img" aria-label="Versão no ar" title="Versão no ar" className="h-1.5 w-1.5 shrink-0 cursor-help rounded-full bg-brand-500" />}
          </span>
        </aside>
        <div className="space-y-5">
          {release.grupos.map(group => <section key={group.tipo}>
            <span className={`inline-block select-none rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tagClass[group.tipo]}`}>{rotulo[group.tipo]}</span>
            <ul className="mt-2.5 space-y-2">
              {group.itens.map(item => <li key={item} className="relative pl-4 text-sm leading-relaxed text-slate-700 before:absolute before:left-0 before:top-[0.7em] before:h-px before:w-1.5 before:bg-slate-400">
                {noteParts(item).map((part, i) => part.bold ? <strong key={i} className="font-semibold">{part.text}</strong> : <span key={i}>{part.text}</span>)}
              </li>)}
            </ul>
          </section>)}
        </div>
      </article>)}

      {totalPages > 1 && <nav aria-label="Páginas das notas de atualização" className="mt-3 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{page > 1 && <Link to={page - 1 === 1 ? '/notas' : `/notas?pagina=${page - 1}`} className={pageLink}><IconBack className="h-3.5 w-3.5" aria-hidden />Notas mais recentes</Link>}</span>
        <span aria-current="page" className="tabular select-none text-center text-2xs font-semibold uppercase tracking-wider text-muted">Página {page} de {totalPages}</span>
        <span>{page < totalPages && <Link to={`/notas?pagina=${page + 1}`} className={pageLink}>Notas mais antigas<IconOpen className="h-3.5 w-3.5" aria-hidden /></Link>}</span>
      </nav>}

      <footer className="mt-10 border-t border-line pt-5 text-xs text-muted">
        As versões seguem <strong className="font-semibold">ano.mês.sequência</strong>: 26.09.3, por exemplo, é a terceira versão de setembro de 2026.
      </footer>
    </main>
  </div>;
}
