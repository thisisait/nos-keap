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

/**
 * Thin facade over the per-domain API modules, plus server-health state.
 *
 * Every method below is a plain function held on a module-scope object literal
 * (see services/api/*.ts) — the reference is created once at module evaluation
 * and never reassigned, and none of them close over `this`. They are therefore
 * already referentially stable across renders, which is the only property a
 * consumer's dependency array needs.
 *
 * These used to be wrapped in `useCallback(api.method, [])`. That wrapper was a
 * no-op: `useCallback` with an empty dep array returns the function it was given
 * on the first render and returns that same one forever, and the input was
 * already the same reference every render. It also tripped
 * react-hooks/exhaustive-deps 22 times ("received a function whose dependencies
 * are unknown"), because the rule cannot see inside a non-inline function to
 * check its deps. Passing the stable references straight through is identical at
 * runtime and honest to the linter.
 */
export const useDatabase = () => {
  const { isInitialized, error } = useServerHealth();

  return {
    isInitialized,
    error,

    // Courses
    getCourses: coursesApi.getCourses,
    getUserStats: coursesApi.getUserStats,
    updateProgress: coursesApi.updateProgress,

    // Completion
    getCompletedItems: completionApi.getCompletedItems,
    toggleItemCompletion: completionApi.toggleItemCompletion,

    // Taxonomy
    getTaxonomyMetadata: taxonomyApi.getTaxonomyMetadata,
    saveTaxonomyMetadata: taxonomyApi.saveTaxonomyMetadata,
    deleteTaxonomyMetadata: taxonomyApi.deleteTaxonomyMetadata,

    // Metadata
    getAllMetadataApi: metadataApi.getAllMetadata,
    getMetadataByDomainApi: metadataApi.getMetadataByDomain,
    saveMetadataApi: metadataApi.saveMetadata,

    // Homepage
    getHomepageTiles: homepageApi.getHomepageTiles,
    saveHomepageTiles: homepageApi.saveHomepageTiles,

    // Activity
    trackActivity: activityApi.trackActivity,
    getRecentActivity: activityApi.getRecentActivity,

    // App
    getAppMetadata: appApi.getAppMetadata,

    // Settings
    saveSetting: settingsApi.saveSetting,
    getSetting: settingsApi.getSetting,

    // Todos
    getTodos: todosApi.getTodos,
    saveTodo: todosApi.saveTodo,
    deleteTodo: todosApi.deleteTodo
  };
};
