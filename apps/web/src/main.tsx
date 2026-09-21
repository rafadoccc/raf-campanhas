import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Navigation } from './components/navigation';
import DashboardPage from './pages/dashboard';
import CampaignsPage from './pages/campaigns';
import CampaignPage from './pages/campaign-detail';
import SettingsPage from './pages/settings';
import HistoryPage from './pages/history';
import LoginPage from './pages/login';
import AccountPage from './pages/account';
import CampaignForm from './components/campaign-form';

// Telas internas: sem sessão, vai para o login e volta para cá depois de entrar.
function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <p className="p-12 text-slate-500">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <><Navigation /><Outlet /></>;
}

function EditCampaign() {
  const { id } = useParams();
  return <CampaignForm key={id} campaignId={id} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
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
            <Route path="/grupos" element={<Navigate to="/configuracoes" replace />} />
            <Route path="*" element={<main className="p-12"><h1 className="text-2xl font-bold">Página não encontrada</h1></main>} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
