// Client-side types only - no server dependencies

export interface UserProgress {
  courseId: number;
  progress: number;
  completedChapters: number;
}

export interface CompletedItem {
  id: string;
  completedAt: number;
}

export interface TaxonomyMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  links: string;
  translations: string;
  data?: any;
  updatedAt?: number;
}

export interface ApiTaxonomyMetadata {
  id: string;
  title: string;
  description?: string;
  url?: string;
  domain?: string;
  metadata?: any;
  createdAt: number;
  updatedAt: number;
}

export interface HomepageTile {
  id: string;
  title: string;
  type: 'progress' | 'custom-todo' | 'recent-cities' | 'recent-pages' | 'progress-stats';
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

export interface AppSettings {
  key: string;
  value: string;
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}