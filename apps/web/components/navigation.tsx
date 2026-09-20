import Link from 'next/link';

const items = [
  ['Conexão WhatsApp', '/configuracoes'],
  ['Dashboard', '/'],
  ['Campanhas', '/campanhas'],
  ['Nova campanha', '/nova-campanha'],
  ['Histórico', '/historico']
];

export function Navigation() {
  return <nav className="flex flex-wrap gap-2 border-b border-slate-200 bg-white px-6 py-4">
    <Link href="/" className="mr-5 font-bold text-slate-900">Central de Campanhas</Link>
    {items.map(([label, href]) => <Link key={href} href={href} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-950">{label}</Link>)}
  </nav>;
}
