import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { hasUnseenReleaseNotes } from '../lib/release-notes-seen';
import { IconAccount, IconAdmin, IconCampaigns, IconChevron, IconHistory, IconHome, IconLogout, IconPassword, IconWhatsApp, IconPrivacy, IconDocument, IconNotes, IconFeedback, Logo, Menu } from '../design';

const items = [
  { label: 'Início', to: '/', icon: IconHome },
  { label: 'Campanhas', to: '/campanhas', icon: IconCampaigns },
  { label: 'Histórico', to: '/historico', icon: IconHistory },
  { label: 'WhatsApp', to: '/configuracoes', icon: IconWhatsApp },
];

const itemClass = (active: boolean) =>
  `inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-2.5 text-sm transition-colors ${active ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:bg-slate-50 hover:text-ink'}`;
const linkClass = ({ isActive }: { isActive: boolean }) => itemClass(isActive);
const iconOnly = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-slate-50 hover:text-ink disabled:opacity-50';

export function Navigation() {
  const { user, signOut } = useAuth();
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const onAccount = useLocation().pathname === '/conta';
  const admin = user?.role === 'SUPER_ADMIN';
  // Lido uma vez ao montar o menu: abrir /notas marca como lido e, na volta, o menu monta de novo.
  const [unseenNotes] = useState(hasUnseenReleaseNotes);
  // No celular o nome do sistema sai: sem ele, todos os ícones cabem (antes WhatsApp e
  // Administração ficavam escondidos numa rolagem lateral). Só ícone = rótulo em aria-label.
  return <nav className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-white px-2 sm:px-4">
    <Link to="/" className="mr-3 hidden shrink-0 sm:block" aria-label="DocDrop: ir para o Início"><Logo className="text-base" /></Link>
    <div className="scroll-area flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden">
      {/* Rótulo só a partir do lg (1024 px): entre 640 e 1023 (tablet e telas médias) só ícone
          cabe sem forçar uma rolagem lateral escondida no meio do menu. */}
      {items.map(({ label, to, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className={linkClass} aria-label={label} title={label}><Icon className="h-4 w-4" aria-hidden /><span className="hidden lg:inline">{label}</span></NavLink>)}
      {admin && <NavLink to="/admin" className={linkClass} aria-label="Administração" title="Administração"><IconAdmin className="h-4 w-4" aria-hidden /><span className="hidden lg:inline">Administração</span></NavLink>}
    </div>
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {/* Clicar no nome abre um menu (em vez de ir direto para a troca de senha). */}
      <Menu label="Minha conta" triggerClassName={itemClass(onAccount)}
        trigger={<><IconAccount className="h-4 w-4" aria-hidden /><span className="hidden max-w-[10rem] truncate lg:inline">{user?.name ?? 'Minha conta'}</span><IconChevron className="hidden h-3.5 w-3.5 text-slate-400 lg:block" aria-hidden /></>}
        header={<><p className="truncate text-sm font-medium text-ink">{user?.name}</p><p className="truncate text-2xs text-muted">{user?.email}</p></>}
        items={[
          { label: 'Minha conta e senha', icon: IconPassword, onSelect: () => navigate('/conta') },
          { label: 'Sugestões e críticas', icon: IconFeedback, onSelect: () => navigate('/sugestoes') },
          { label: 'Privacidade', icon: IconPrivacy, onSelect: () => navigate('/privacidade') },
          { label: 'Termos de Uso', icon: IconDocument, onSelect: () => navigate('/termos') },
        ]} />
      {logoutError && <span role="alert" className="max-w-44 text-xs text-red-700" title={logoutError}>Não foi possível sair. Tente novamente.</span>}
      {/* Novidades e Sair: só ícone, do mesmo tamanho. O pontinho avisa que há versão nova não lida. */}
      <Link to="/notas" className={`${iconOnly} relative`} aria-label={unseenNotes ? 'Novidades (há atualizações não lidas)' : 'Novidades'} title="Novidades do sistema">
        <IconNotes className="h-4 w-4" aria-hidden />
        {unseenNotes && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand-500 ring-2 ring-white" aria-hidden />}
      </Link>
      <button type="button" disabled={loggingOut} aria-label="Sair" title="Sair" className={iconOnly} onClick={() => {
        setLoggingOut(true); setLogoutError('');
        void signOut().catch(error => setLogoutError(errorMessage(error))).finally(() => setLoggingOut(false));
      }}>
        <IconLogout className="h-4 w-4" aria-hidden />
      </button>
    </div>
  </nav>;
}
