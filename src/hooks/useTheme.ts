import { useEffect, useState } from 'react';
import { useDatabase } from './useDatabase';

export const useTheme = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const { getSetting, saveSetting, isInitialized } = useDatabase();

  useEffect(() => {
    if (!isInitialized) return;

    // Load theme from database first, then fallback to localStorage
    const savedTheme = getSetting('theme') || localStorage.getItem('app-theme') || 'light';
    const themeValue = savedTheme === 'dark' ? 'dark' : 'light';
    
    setTheme(themeValue);
    applyTheme(themeValue);
  }, [isInitialized, getSetting]);

  const applyTheme = (newTheme: 'light' | 'dark') => {
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('app-theme', newTheme);
  };

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    applyTheme(newTheme);
    saveSetting('theme', newTheme);
  };

  const setThemeValue = (newTheme: 'light' | 'dark') => {
    setTheme(newTheme);
    applyTheme(newTheme);
    saveSetting('theme', newTheme);
  };

  return {
    theme,
    isDark: theme === 'dark',
    toggleTheme,
    setTheme: setThemeValue
  };
};