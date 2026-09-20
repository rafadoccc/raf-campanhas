import './globals.css';
import type { Metadata } from 'next';
import { Navigation } from '../components/navigation';
export const metadata: Metadata = { title: 'Campanhas', description: 'Gerenciador de campanhas' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body><Navigation />{children}</body></html>; }
