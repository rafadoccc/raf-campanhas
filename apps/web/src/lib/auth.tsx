import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { screenCache } from './cache';

/** termsPending: falta aceitar a versão atual dos Termos e da Política (LGPD, ADR-040). */
export type User = { id: string; email: string; name: string; role: string; termsPending?: boolean };
type AuthState = {
  /** undefined enquanto confere a sessão; null quando não há login. */
  user: User | null | undefined;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  acceptTerms(): Promise<void>;
  /** A conta foi excluída: sai do painel aqui e nas outras abas. */
  accountDeleted(): void;
};

const AuthContext = createContext<AuthState | null>(null);
// Avisa as outras abas do mesmo navegador (definido quando o AuthProvider monta).
let broadcast: (message: 'entrou' | 'saiu') => void = () => undefined;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setCurrentUser] = useState<User | null | undefined>(undefined);
  // Saiu ou trocou de conta: o que as telas guardaram do usuário anterior vai embora junto.
  const setUser = (next: User | null) => setCurrentUser(current => {
    if (!next || next.id !== current?.id) screenCache.clear();
    return next;
  });
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    // Confere a sessão no servidor. Só um 401 tira do painel: sem rede, fica como está.
    const check = () => api<{ user: User }>('/auth/me')
      // Mesma conta: não mexe no estado (a tela não é redesenhada a cada conferência).
      .then(r => setCurrentUser(current => {
        if (current && r.user && current.id === r.user.id && current.role === r.user.role && current.name === r.user.name && current.termsPending === r.user.termsPending) return current;
        if (!r.user || r.user.id !== current?.id) screenCache.clear();
        return r.user;
      }))
      .catch(error => { if (error instanceof ApiError && error.status === 401) setUser(null); });
    void api<{ user: User }>('/auth/me').then(r => setUser(r.user)).catch(() => setUser(null));
    // Uma tela aberta sem fazer pedidos (ex.: o formulário de campanha) continuava mostrando os
    // grupos e o botão de criar depois de a sessão acabar em outro lugar (Sair em outra aba ou no
    // celular, admin encerrou, login venceu). Agora a sessão é conferida ao voltar para a aba,
    // ao restaurar a página pelo Voltar do navegador e a cada minuto com a aba visível.
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('pageshow', onPageShow);
    const timer = window.setInterval(onVisible, 60_000);
    // Sair numa aba fecha o painel nas outras abas do mesmo navegador na hora.
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel('campanhas-sessao');
      channel.onmessage = event => { if (event.data === 'saiu') setUser(null); else if (event.data === 'entrou') void check(); };
    } catch { /* navegador sem BroadcastChannel: fica só a conferência periódica */ }
    broadcast = message => { try { channel?.postMessage(message); } catch { /* ignora */ } };
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.clearInterval(timer);
      channel?.close();
    };
  }, []);
  async function signIn(email: string, password: string) {
    const r = await api<{ user: User }>('/auth/login', { method: 'POST', json: { email, password } });
    setUser(r.user);
    broadcast('entrou');
  }
  async function signOut() {
    // Sem confirmação do servidor, o cookie pode continuar válido. Não finja que a sessão acabou.
    await api('/auth/logout', { method: 'POST', json: {} });
    setUser(null);
    broadcast('saiu');
  }
  async function acceptTerms() {
    const r = await api<{ user: User }>('/account/terms', { method: 'POST', json: {} });
    setUser(r.user);
    broadcast('entrou'); // as outras abas conferem e liberam o painel também
  }
  function accountDeleted() {
    setUser(null);
    broadcast('saiu');
  }
  return <AuthContext.Provider value={{ user, signIn, signOut, acceptTerms, accountDeleted }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth fora do AuthProvider');
  return context;
}
