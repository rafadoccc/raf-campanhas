import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const items = [
  ['Conexão WhatsApp', '/configuracoes'],
  ['Dashboard', '/'],
  ['Campanhas', '/campanhas'],
  ['Nova campanha', '/nova-campanha'],
  ['Histórico', '/historico']
];

export function Navigation() {
  const { user, signOut } = useAuth();
  const link = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-1.5 text-sm hover:bg-slate-100 hover:text-slate-950 ${isActive ? 'bg-slate-100 font-semibold text-slate-950' : 'text-slate-600'}`;
  return <nav className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-6 py-4">
    <Link to="/" className="mr-5 font-bold text-slate-900">Central de Campanhas</Link>
    {items.map(([label, href]) => <NavLink key={href} to={href} end={href === '/'} className={link}>{label}</NavLink>)}
    <span className="ml-auto flex items-center gap-3 text-sm text-slate-600">
      <NavLink to="/conta" className={link}>{user?.name ?? 'Minha conta'}</NavLink>
      <button type="button" onClick={() => void signOut()} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100">Sair</button>
    </span>
  </nav>;
}
