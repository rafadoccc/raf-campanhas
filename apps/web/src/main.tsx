import { StrictMode, lazy, Suspense, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Navigation } from './components/navigation';
import { ConfirmProvider } from './design';
import DashboardPage from './pages/dashboard';
import LoginPage from './pages/login';

// Aba aberta antes de uma atualização do sistema: os arquivos antigos da tela já não existem.
// Recarrega UMA vez para pegar a versão nova, em vez de ficar em branco. Se recarregou há
// menos de 30 s e falhou de novo, o problema é outro: deixa o erro aparecer.
function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem('reload-after-update') ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem('reload-after-update', String(Date.now()));
  } catch { /* sem sessionStorage: recarrega mesmo assim */ }
  window.location.reload();
  return true;
}
window.addEventListener('vite:preloadError', event => { if (reloadOnce()) event.preventDefault(); });
function page<C extends ComponentType<any>>(load: () => Promise<{ default: C }>) {
  return lazy(() => load().catch(error => {
    if (reloadOnce()) return new Promise<never>(() => undefined); // a página vai recarregar
    throw error;
  }));
}

// Telas menos usadas carregam sob demanda: o início abre mais rápido.
const CampaignsPage = page(() => import('./pages/campaigns'));
const CampaignPage = page(() => import('./pages/campaign-detail'));
const CampaignForm = page(() => import('./components/campaign-form'));
const SettingsPage = page(() => import('./pages/settings'));
const HistoryPage = page(() => import('./pages/history'));
const AccountPage = page(() => import('./pages/account'));
const AdminPage = page(() => import('./pages/admin'));

// Moldura: menu fixo em cima e a tela ocupando exatamente o resto da janela. Cada tela decide
// o que rola (listas têm rolagem própria; o documento não rola).
function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <p className="p-8 text-muted">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <div className="flex h-dvh flex-col">
    <Navigation />
    <div className="scroll-area min-h-0 flex-1">
      <Suspense fallback={<p className="p-8 text-muted">Carregando…</p>}><Outlet /></Suspense>
    </div>
  </div>;
}

/** Só SUPER_ADMIN (o servidor também recusa; aqui é só para não mostrar a tela). */
function RequireAdmin() {
  const { user } = useAuth();
  return user?.role === 'SUPER_ADMIN' ? <Outlet /> : <Navigate to="/" replace />;
}

function EditCampaign() {
  const { id } = useParams();
  return <CampaignForm key={id} campaignId={id} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/campanhas" element={<CampaignsPage />} />
              <Route path="/campanhas/:id" element={<CampaignPage />} />
              <Route path="/campanhas/:id/editar" element={<EditCampaign />} />
              <Route path="/nova-campanha" element={<CampaignForm />} />
              <Route path="/configuracoes" element={<SettingsPage />} />
              <Route path="/historico" element={<HistoryPage />} />
              <Route path="/conta" element={<AccountPage />} />
              <Route element={<RequireAdmin />}><Route path="/admin" element={<AdminPage />} /></Route>
              <Route path="/grupos" element={<Navigate to="/configuracoes" replace />} />
              <Route path="*" element={<main className="p-8"><h1 className="text-lg font-semibold">Página não encontrada</h1></main>} />
            </Route>
          </Routes>
        </ConfirmProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
