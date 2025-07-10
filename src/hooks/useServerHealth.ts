import { useState, useEffect } from 'react';

export const useServerHealth = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const response = await fetch('/api/health');
        if (response.ok) {
          setIsInitialized(true);
        } else {
          setError('Server not responding');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect to server');
      }
    };

    checkHealth();
  }, []);

  return { isInitialized, error };
};