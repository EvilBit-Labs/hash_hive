import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ErrorBoundary } from './components/features/error-boundary';
import { AppLayout } from './components/features/layout';
import { ProtectedRoute } from './components/features/protected-route';
import './index.css';
import { useAuthStore } from './stores/auth';

// Route-level code splitting — each page is loaded on demand
const DashboardPage = lazy(() =>
  import('./pages/dashboard').then((m) => ({ default: m.DashboardPage }))
);
const LoginPage = lazy(() => import('./pages/login').then((m) => ({ default: m.LoginPage })));
const SelectProjectPage = lazy(() =>
  import('./pages/select-project').then((m) => ({ default: m.SelectProjectPage }))
);
const AgentsPage = lazy(() => import('./pages/agents').then((m) => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() =>
  import('./pages/agent-detail').then((m) => ({ default: m.AgentDetailPage }))
);
const CampaignsPage = lazy(() =>
  import('./pages/campaigns').then((m) => ({ default: m.CampaignsPage }))
);
const CampaignCreatePage = lazy(() =>
  import('./pages/campaign-create').then((m) => ({ default: m.CampaignCreatePage }))
);
const CampaignDetailPage = lazy(() =>
  import('./pages/campaign-detail').then((m) => ({ default: m.CampaignDetailPage }))
);
const ResourcesPage = lazy(() =>
  import('./pages/resources').then((m) => ({ default: m.ResourcesPage }))
);
const HashListDetailPage = lazy(() =>
  import('./pages/hash-list-detail').then((m) => ({ default: m.HashListDetailPage }))
);
const ResultsPage = lazy(() => import('./pages/results').then((m) => ({ default: m.ResultsPage })));
const NotFoundPage = lazy(() =>
  import('./pages/not-found').then((m) => ({ default: m.NotFoundPage }))
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

function App() {
  const { fetchUser } = useAuthStore();

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense
            fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
          >
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/select-project" element={<SelectProjectPage />} />
              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/campaigns" element={<CampaignsPage />} />
                  <Route path="/campaigns/new" element={<CampaignCreatePage />} />
                  <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
                  <Route path="/agents" element={<AgentsPage />} />
                  <Route path="/agents/:id" element={<AgentDetailPage />} />
                  <Route path="/resources" element={<ResourcesPage />} />
                  <Route path="/resources/hash-lists/:id" element={<HashListDetailPage />} />
                  <Route path="/results" element={<ResultsPage />} />
                </Route>
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
