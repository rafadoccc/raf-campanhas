import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Navigation } from './components/navigation';
import { ConfirmProvider } from './design';
import DashboardPage from './pages/dashboard';
import LoginPage from './pages/login';

// Telas menos usadas carregam sob demanda: o início abre mais rápido.
const CampaignsPage = lazy(() => import('./pages/campaigns'));
const CampaignPage = lazy(() => import('./pages/campaign-detail'));
const CampaignForm = lazy(() => import('./components/campaign-form'));
const SettingsPage = lazy(() => import('./pages/settings'));
const HistoryPage = lazy(() => import('./pages/history'));
const AccountPage = lazy(() => import('./pages/account'));
const AdminPage = lazy(() => import('./pages/admin'));

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
