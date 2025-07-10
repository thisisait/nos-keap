import { useCallback } from 'react';
import { useServerHealth } from './useServerHealth';
import { coursesApi } from '../services/api/courses';
import { taxonomyApi } from '../services/api/taxonomy';
import { todosApi } from '../services/api/todos';
import { homepageApi } from '../services/api/homepage';
import { activityApi } from '../services/api/activity';
import { settingsApi } from '../services/api/settings';
import { metadataApi } from '../services/api/metadata';
import { completionApi } from '../services/api/completion';
import { appApi } from '../services/api/app';

// Re-export types for backward compatibility
export type { UserProgress, TaxonomyMetadata, HomepageTile, AppMetadata, TodoItem } from '../types/database';

export const useDatabase = () => {
  const { isInitialized, error } = useServerHealth();

  // Courses
  const getCourses = useCallback(coursesApi.getCourses, []);
  const getUserStats = useCallback(coursesApi.getUserStats, []);
  const updateProgress = useCallback(coursesApi.updateProgress, []);

  // Completion
  const getCompletedItems = useCallback(completionApi.getCompletedItems, []);
  const toggleItemCompletion = useCallback(completionApi.toggleItemCompletion, []);

  // Taxonomy
  const getTaxonomyMetadata = useCallback(taxonomyApi.getTaxonomyMetadata, []);
  const saveTaxonomyMetadata = useCallback(taxonomyApi.saveTaxonomyMetadata, []);
  const deleteTaxonomyMetadata = useCallback(taxonomyApi.deleteTaxonomyMetadata, []);

  // Metadata
  const getAllMetadataApi = useCallback(metadataApi.getAllMetadata, []);
  const getMetadataByDomainApi = useCallback(metadataApi.getMetadataByDomain, []);
  const saveMetadataApi = useCallback(metadataApi.saveMetadata, []);

  // Homepage
  const getHomepageTiles = useCallback(homepageApi.getHomepageTiles, []);
  const saveHomepageTiles = useCallback(homepageApi.saveHomepageTiles, []);

  // Activity
  const trackActivity = useCallback(activityApi.trackActivity, []);
  const getRecentActivity = useCallback(activityApi.getRecentActivity, []);

  // App
  const getAppMetadata = useCallback(appApi.getAppMetadata, []);

  // Settings
  const saveSetting = useCallback(settingsApi.saveSetting, []);
  const getSetting = useCallback(settingsApi.getSetting, []);

  // Todos
  const getTodos = useCallback(todosApi.getTodos, []);
  const saveTodo = useCallback(todosApi.saveTodo, []);
  const deleteTodo = useCallback(todosApi.deleteTodo, []);

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