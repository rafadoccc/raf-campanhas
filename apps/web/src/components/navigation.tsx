import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { IconAccount, IconAdmin, IconCampaigns, IconHistory, IconHome, IconLogout, IconWhatsApp } from '../design';

const items = [
  { label: 'Início', to: '/', icon: IconHome },
  { label: 'Campanhas', to: '/campanhas', icon: IconCampaigns },
  { label: 'Histórico', to: '/historico', icon: IconHistory },
  { label: 'WhatsApp', to: '/configuracoes', icon: IconWhatsApp },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-2.5 text-sm transition-colors ${isActive ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:bg-slate-50 hover:text-ink'}`;

export function Navigation() {
  const { user, signOut } = useAuth();
  const admin = user?.role === 'SUPER_ADMIN';
  return <nav className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-white px-4">
    <Link to="/" className="mr-3 flex shrink-0 items-center gap-2 font-semibold tracking-tight">
      <span aria-hidden className="grid h-6 w-6 place-items-center rounded bg-brand-600 text-2xs font-bold text-white">CC</span>
      <span className="hidden sm:inline">Central de Campanhas</span>
    </Link>
    <div className="scroll-area flex min-w-0 items-center gap-1 overflow-x-auto">
      {items.map(({ label, to, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className={linkClass}><Icon className="h-4 w-4" aria-hidden /><span className="hidden md:inline">{label}</span></NavLink>)}
      {admin && <NavLink to="/admin" className={linkClass}><IconAdmin className="h-4 w-4" aria-hidden /><span className="hidden md:inline">Administração</span></NavLink>}
    </div>
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <NavLink to="/conta" className={linkClass} title="Minha conta"><IconAccount className="h-4 w-4" aria-hidden /><span className="hidden max-w-[10rem] truncate lg:inline">{user?.name ?? 'Minha conta'}</span></NavLink>
      <button type="button" onClick={() => void signOut()} className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-sm text-muted hover:bg-slate-50 hover:text-ink" title="Sair">
        <IconLogout className="h-4 w-4" aria-hidden /><span className="hidden lg:inline">Sair</span>
      </button>
    </div>
  </nav>;
}
