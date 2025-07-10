import { useState, useEffect, useCallback } from 'react';

export interface UserProgress {
  courseId: number;
  progress: number;
  completedChapters: number;
}

export interface TaxonomyMetadata {
  id: string;
  data: any;
  updatedAt: number;
}

export interface HomepageTile {
  id: string;
  title: string;
  type: 'progress' | 'custom-todo' | 'recent-cities' | 'recent-pages';
  position: number;
  visible: boolean;
  config?: any;
}

export interface AppMetadata {
  id: string;
  version: string;
  lastUpdated: number;
  totalItems: number;
  completedItems: number;
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

export const useDatabase = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check server health to verify database is ready
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

  const getCourses = useCallback(async (): Promise<UserProgress[]> => {
    const response = await fetch('/api/courses');
    if (!response.ok) throw new Error('Failed to fetch courses');
    return response.json();
  }, []);

  const getUserStats = useCallback(async () => {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error('Failed to fetch stats');
    return response.json();
  }, []);

  const updateProgress = useCallback(async (courseId: number, progress: number, completedChapters: number) => {
    const response = await fetch(`/api/courses/${courseId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress, completedChapters })
    });
    if (!response.ok) throw new Error('Failed to update progress');
  }, []);

  const getCompletedItems = useCallback(async (): Promise<string[]> => {
    const response = await fetch('/api/completed-items');
    if (!response.ok) throw new Error('Failed to fetch completed items');
    return response.json();
  }, []);

  const toggleItemCompletion = useCallback(async (itemId: string) => {
    const response = await fetch(`/api/completed-items/${itemId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error('Failed to toggle item completion');
  }, []);

  const getTaxonomyMetadata = useCallback(async (id?: string): Promise<TaxonomyMetadata[] | TaxonomyMetadata | null> => {
    const url = id ? `/api/taxonomy-metadata/${id}` : '/api/taxonomy-metadata';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch taxonomy metadata');
    return response.json();
  }, []);

  const saveTaxonomyMetadata = useCallback(async (metadata: TaxonomyMetadata) => {
    const response = await fetch('/api/taxonomy-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
    if (!response.ok) throw new Error('Failed to save taxonomy metadata');
  }, []);

  const deleteTaxonomyMetadata = useCallback(async (id: string) => {
    const response = await fetch(`/api/taxonomy-metadata/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete taxonomy metadata');
  }, []);

  const getHomepageTiles = useCallback(async (): Promise<HomepageTile[]> => {
    const response = await fetch('/api/homepage-tiles');
    if (!response.ok) throw new Error('Failed to fetch homepage tiles');
    return response.json();
  }, []);

  const saveHomepageTiles = useCallback(async (tiles: HomepageTile[]) => {
    const response = await fetch('/api/homepage-tiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiles)
    });
    if (!response.ok) throw new Error('Failed to save homepage tiles');
  }, []);

  const trackActivity = useCallback(async (itemId: string, itemType: string) => {
    const response = await fetch('/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, itemType })
    });
    if (!response.ok) throw new Error('Failed to track activity');
  }, []);

  const getRecentActivity = useCallback(async (type?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (limit) params.set('limit', limit.toString());
    
    const response = await fetch(`/api/activity?${params}`);
    if (!response.ok) throw new Error('Failed to fetch recent activity');
    return response.json();
  }, []);

  const getAppMetadata = useCallback(async (): Promise<AppMetadata | null> => {
    const response = await fetch('/api/app-metadata');
    if (!response.ok) throw new Error('Failed to fetch app metadata');
    return response.json();
  }, []);

  const saveSetting = useCallback(async (key: string, value: string) => {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
    if (!response.ok) throw new Error('Failed to save setting');
  }, []);

  const getSetting = useCallback(async (key: string): Promise<string | null> => {
    const response = await fetch(`/api/settings/${key}`);
    if (!response.ok) throw new Error('Failed to get setting');
    return response.json();
  }, []);

  const getTodos = useCallback(async (): Promise<TodoItem[]> => {
    const response = await fetch('/api/todos');
    if (!response.ok) throw new Error('Failed to fetch todos');
    return response.json();
  }, []);

  const saveTodo = useCallback(async (todo: TodoItem) => {
    const response = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(todo)
    });
    if (!response.ok) throw new Error('Failed to save todo');
  }, []);

  const deleteTodo = useCallback(async (id: string) => {
    const response = await fetch(`/api/todos/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete todo');
  }, []);

  const getAllMetadataApi = useCallback(async () => {
    const response = await fetch('/api/metadata');
    if (!response.ok) throw new Error('Failed to fetch metadata');
    return response.json();
  }, []);

  const getMetadataByDomainApi = useCallback(async (domain: string) => {
    const response = await fetch(`/api/metadata/domain/${domain}`);
    if (!response.ok) throw new Error('Failed to fetch metadata by domain');
    return response.json();
  }, []);

  const saveMetadataApi = useCallback(async (metadata: any) => {
    const response = await fetch('/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
    if (!response.ok) throw new Error('Failed to save metadata');
    return response.json();
  }, []);

  return {
    isInitialized,
    error,
    getCourses,
    getUserStats,
    updateProgress,
    getCompletedItems,
    toggleItemCompletion,
    getTaxonomyMetadata,
    saveTaxonomyMetadata,
    deleteTaxonomyMetadata,
    getAllMetadataApi,
    getMetadataByDomainApi,
    saveMetadataApi,
    getHomepageTiles,
    saveHomepageTiles,
    trackActivity,
    getRecentActivity,
    getAppMetadata,
    saveSetting,
    getSetting,
    getTodos,
    saveTodo,
    deleteTodo
  };
};