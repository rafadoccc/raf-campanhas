import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';

export type User = { id: string; email: string; name: string; role: string };
type AuthState = {
  /** undefined enquanto confere a sessão; null quando não há login. */
  user: User | null | undefined;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api<{ user: User }>('/auth/me').then(r => setUser(r.user)).catch(() => setUser(null));
  }, []);
  async function signIn(email: string, password: string) {
    const r = await api<{ user: User }>('/auth/login', { method: 'POST', json: { email, password } });
    setUser(r.user);
  }
  async function signOut() {
    await api('/auth/logout', { method: 'POST', json: {} }).catch(() => undefined);
    setUser(null);
  }
  return <AuthContext.Provider value={{ user, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth fora do AuthProvider');
  return context;
}
