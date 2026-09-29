import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { IconAccount, IconAdmin, IconCampaigns, IconChevron, IconHistory, IconHome, IconLogout, IconPassword, IconWhatsApp, Menu } from '../design';

const items = [
  { label: 'Início', to: '/', icon: IconHome },
  { label: 'Campanhas', to: '/campanhas', icon: IconCampaigns },
  { label: 'Histórico', to: '/historico', icon: IconHistory },
  { label: 'WhatsApp', to: '/configuracoes', icon: IconWhatsApp },
];

const itemClass = (active: boolean) =>
  `inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-2.5 text-sm transition-colors ${active ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:bg-slate-50 hover:text-ink'}`;
const linkClass = ({ isActive }: { isActive: boolean }) => itemClass(isActive);

export function Navigation() {
  const { user, signOut } = useAuth();
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const onAccount = useLocation().pathname === '/conta';
  const admin = user?.role === 'SUPER_ADMIN';
  // No celular o nome do sistema sai: sem ele, todos os ícones cabem (antes WhatsApp e
  // Administração ficavam escondidos numa rolagem lateral). Só ícone = rótulo em aria-label.
  return <nav className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-white px-2 sm:px-4">
    <Link to="/" className="mr-3 hidden shrink-0 truncate font-semibold tracking-tight sm:block">Central de Campanhas</Link>
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
        items={[{ label: 'Alterar senha', icon: IconPassword, onSelect: () => navigate('/conta') }]} />
      {logoutError && <span role="alert" className="max-w-44 text-xs text-red-700" title={logoutError}>Não foi possível sair. Tente novamente.</span>}
      <button type="button" disabled={loggingOut} onClick={() => {
        setLoggingOut(true); setLogoutError('');
        void signOut().catch(error => setLogoutError(errorMessage(error))).finally(() => setLoggingOut(false));
      }} className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-sm text-muted hover:bg-slate-50 hover:text-ink disabled:opacity-50" title="Sair">
        <IconLogout className="h-4 w-4" aria-hidden /><span className="hidden lg:inline">Sair</span>
      </button>
    </div>
  </nav>;
}
