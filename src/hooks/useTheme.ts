import { useEffect, useState } from 'react';
import { useDatabase } from './useDatabase';

const applyTheme = (newTheme: 'light' | 'dark') => {
  document.documentElement.classList.toggle('dark', newTheme === 'dark');
  localStorage.setItem('app-theme', newTheme);
};

export const useTheme = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('app-theme') === 'dark' ? 'dark' : 'light',
  );
  const { getSetting, saveSetting, isInitialized } = useDatabase();

  // Sync from the per-user DB setting once the server is reachable. The old
  // code tested the unawaited Promise for truthiness, so the DB value never
  // applied (REVIEW.md §5 async-as-sync bug class).
  useEffect(() => {
    if (!isInitialized) return;
    let cancelled = false;
    (async () => {
      try {
        const dbTheme = await getSetting('theme');
        const resolved = (dbTheme ?? localStorage.getItem('app-theme')) === 'dark' ? 'dark' : 'light';
        if (!cancelled) {
          setTheme(resolved);
          applyTheme(resolved);
        }
      } catch {
        // Server unavailable — the localStorage value already applied.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isInitialized, getSetting]);

  const setThemeValue = (newTheme: 'light' | 'dark') => {
    setTheme(newTheme);
    applyTheme(newTheme);
    saveSetting('theme', newTheme).catch(() => {});
  };

  return {
    theme,
    isDark: theme === 'dark',
    toggleTheme: () => setThemeValue(theme === 'dark' ? 'light' : 'dark'),
    setTheme: setThemeValue,
  };
};
