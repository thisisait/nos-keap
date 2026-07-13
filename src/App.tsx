import { useEffect, lazy, Suspense } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Index from './pages/Index';
import Admin from './pages/Admin';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';
import ExtensionPair from './pages/ExtensionPair';
import ComposeDraft from './pages/ComposeDraft';
import Tables from './pages/Tables';
import TableEditor from './pages/TableEditor';

// Lazy: the explorer pulls in three.js/WebGL — keep it out of the main chunk.
const Explore = lazy(() => import('./pages/Explore'));

const queryClient = new QueryClient();

const App = () => {
  // Apply the persisted theme before any data loads, so there's no flash of
  // the wrong theme. useTheme later syncs the same key from the per-user DB.
  useEffect(() => {
    const savedTheme = localStorage.getItem('app-theme') || 'light';
    document.documentElement.classList.toggle('dark', savedTheme === 'dark');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/admin" element={<Admin />} />
            {/* The card-grid game layer is retired (locked pages made no
                sense pre-content); the universe explorer IS the game now.
                Old bookmarks land in the explorer. */}
            <Route path="/game/*" element={<Navigate to="/explore" replace />} />
            <Route path="/game" element={<Navigate to="/explore" replace />} />
            <Route
              path="/explore"
              element={
                <Suspense fallback={null}>
                  <Explore />
                </Suspense>
              }
            />
            <Route path="/tables" element={<Tables />} />
            <Route path="/tables/:id" element={<TableEditor />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/extension/pair" element={<ExtensionPair />} />
            <Route path="/compose/:id" element={<ComposeDraft />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
