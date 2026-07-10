import { useEffect } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Index from './pages/Index';
import Admin from './pages/Admin';
import Game from './pages/Game';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';

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
            <Route path="/game" element={<Game />} />
            <Route path="/game/island/:id" element={<Game />} />
            <Route path="/game/city/:id" element={<Game />} />
            <Route path="/game/building/:id" element={<Game />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
