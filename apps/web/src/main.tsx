import { StrictMode, lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Navigation } from './components/navigation';
import { ConfirmProvider } from './design';
import DashboardPage from './pages/dashboard';
import LoginPage from './pages/login';
import { TermsGate } from './components/terms-gate';

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

// Tela carregada sob demanda, com `preload()` para baixá-la antes do clique. Depois de baixada,
// abre direto, sem passar pelo "Carregando…" do Suspense.
const pages: { preload: () => Promise<unknown> }[] = [];
function page<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<{ default: ComponentType<P> }> | null = null;
  const preload = () => pending ??= load()
    .then(module => { loaded = module.default; return module; })
    .catch(error => { pending = null; throw error; });
  const Lazy = lazy(() => preload().catch(error => {
    if (reloadOnce()) return new Promise<never>(() => undefined); // a página vai recarregar
    throw error;
  }));
  function Screen(props: P) {
    // Decidido uma vez por montagem: trocar de Lazy para o componente no meio remontaria a tela.
    const [Component] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  pages.push({ preload });
  return Screen;
}

// Telas além do Início carregam à parte (o login e o Início abrem mais rápido) e são baixadas
// logo depois, com o navegador ocioso: a troca de tela não espera download.
const CampaignsPage = page(() => import('./pages/campaigns'));
const CampaignPage = page(() => import('./pages/campaign-detail'));
const CampaignForm = page<{ campaignId?: string }>(() => import('./components/campaign-form'));
const SettingsPage = page(() => import('./pages/settings'));
const HistoryPage = page(() => import('./pages/history'));
const AccountPage = page(() => import('./pages/account'));
const AdminPage = page(() => import('./pages/admin'));
const FeedbackPage = page(() => import('./pages/feedback'));
// Relatório da campanha: fora da moldura do painel, para imprimir sem cortar. O do dono confere o
// login por conta própria; o do link (/r/:token) abre sem login.
const CampaignReportPage = lazy(() => import('./pages/report'));
const SharedReportPage = lazy(() => import('./pages/report').then(module => ({ default: module.SharedReportPage })));
// Esqueci minha senha: públicas, carregadas só quando alguém abre.
const ForgotPasswordPage = lazy(() => import('./pages/password-reset'));
const ResetPasswordPage = lazy(() => import('./pages/password-reset').then(module => ({ default: module.ResetPasswordPage })));
// Privacidade e Termos: públicas (abrem sem login), carregadas só quando alguém abre.
const LegalPage = lazy(() => import('./pages/legal'));
// Notas de atualização: página de leitura, fora da moldura do painel.
const ReleaseNotesPage = lazy(() => import('./pages/release-notes'));

function preloadPages() {
  const run = () => { for (const p of pages) void p.preload().catch(() => undefined); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 500);
}

/** "Carregando…" só se demorar: numa troca rápida, nada pisca na tela. */
function Pending() {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 300); return () => clearTimeout(timer); }, []);
  return visible ? <p className="p-8 text-muted">Carregando…</p> : null;
}

// Moldura: menu fixo em cima e a tela ocupando exatamente o resto da janela. Cada tela decide
// o que rola (listas têm rolagem própria; o documento não rola).
function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  const signedIn = Boolean(user);
  useEffect(() => { if (signedIn) preloadPages(); }, [signedIn]);
  if (user === undefined) return <Pending />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  // LGPD (ADR-040): o painel só abre depois do aceite da versão atual dos termos.
  if (user.termsPending) return <TermsGate />;
  // relative + overflow-hidden: nada escapa da moldura e o documento nunca rola (o menu fica fixo).
  return <div className="relative flex h-dvh flex-col overflow-hidden">
    <Navigation />
    <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
      <Suspense fallback={<Pending />}><Outlet /></Suspense>
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
            <Route path="/esqueci-senha" element={<Suspense fallback={<Pending />}><ForgotPasswordPage /></Suspense>} />
            <Route path="/redefinir-senha/:token" element={<Suspense fallback={<Pending />}><ResetPasswordPage /></Suspense>} />
            <Route path="/privacidade" element={<Suspense fallback={<Pending />}><LegalPage kind="privacy" /></Suspense>} />
            <Route path="/termos" element={<Suspense fallback={<Pending />}><LegalPage kind="terms" /></Suspense>} />
            <Route path="/notas" element={<Suspense fallback={<Pending />}><ReleaseNotesPage /></Suspense>} />
            <Route path="/campanhas/:id/relatorio" element={<Suspense fallback={<Pending />}><CampaignReportPage /></Suspense>} />
            <Route path="/r/:token" element={<Suspense fallback={<Pending />}><SharedReportPage /></Suspense>} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/campanhas" element={<CampaignsPage />} />
              <Route path="/campanhas/:id" element={<CampaignPage />} />
              <Route path="/campanhas/:id/editar" element={<EditCampaign />} />
              <Route path="/nova-campanha" element={<CampaignForm />} />
              <Route path="/configuracoes" element={<SettingsPage />} />
              <Route path="/historico" element={<HistoryPage />} />
              <Route path="/conta" element={<AccountPage />} />
              <Route path="/sugestoes" element={<FeedbackPage />} />
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
