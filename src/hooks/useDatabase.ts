import { useState, useEffect, useCallback } from 'react';
import { databaseService } from '@/services/database';

export const useDatabase = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initDb = async () => {
      try {
        await databaseService.initialize();
        setIsInitialized(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Database initialization failed');
      }
    };

    initDb();
  }, []);

  const getCourses = useCallback(() => {
    return databaseService.getAllCourses();
  }, []);

  const getUserStats = useCallback(() => {
    return databaseService.getUserStats();
  }, []);

  const updateProgress = useCallback((courseId: number, progress: number, completedChapters: number) => {
    databaseService.updateCourseProgress(courseId, progress, completedChapters);
  }, []);

  const getCompletedItems = useCallback(() => {
    return databaseService.getCompletedItems();
  }, []);

  const toggleItemCompletion = useCallback((itemId: string) => {
    const completedItems = databaseService.getCompletedItems();
    if (completedItems.includes(itemId)) {
      databaseService.removeCompletedItem(itemId);
    } else {
      databaseService.addCompletedItem(itemId);
    }
  }, []);

  const getTaxonomyMetadata = useCallback((id?: string) => {
    return databaseService.getTaxonomyMetadata(id);
  }, []);

  const saveTaxonomyMetadata = useCallback((metadata: any) => {
    return databaseService.saveTaxonomyMetadata(metadata);
  }, []);

  const deleteTaxonomyMetadata = useCallback((id: string) => {
    return databaseService.deleteTaxonomyMetadata(id);
  }, []);

  const getHomepageTiles = useCallback(() => {
    return databaseService.getHomepageTiles();
  }, []);

  const saveHomepageTiles = useCallback((tiles: any[]) => {
    return databaseService.saveHomepageTiles(tiles);
  }, []);

  const trackActivity = useCallback((itemId: string, itemType: string) => {
    return databaseService.trackActivity(itemId, itemType);
  }, []);

  const getRecentActivity = useCallback((type?: string, limit?: number) => {
    return databaseService.getRecentActivity(type, limit);
  }, []);

  const getAppMetadata = useCallback(() => {
    return databaseService.getAppMetadata();
  }, []);

  const saveSetting = useCallback((key: string, value: string) => {
    return databaseService.saveSetting(key, value);
  }, []);

  const getSetting = useCallback((key: string) => {
    return databaseService.getSetting(key);
  }, []);

  const getTodos = useCallback(() => {
    return databaseService.getTodos();
  }, []);

  const saveTodo = useCallback((todo: any) => {
    return databaseService.saveTodo(todo);
  }, []);

  const deleteTodo = useCallback((id: string) => {
    return databaseService.deleteTodo(id);
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
    getAllMetadataApi: databaseService.getAllMetadataApi.bind(databaseService),
    getMetadataByDomainApi: databaseService.getMetadataByDomainApi.bind(databaseService),
    saveMetadataApi: databaseService.saveMetadataApi.bind(databaseService),
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