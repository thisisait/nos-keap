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
  /** Content ref into an nOS service, e.g. "kiwix:wikipedia_en" */
  requiredData?: string;
  /** Raw server-side payload (arbitrary JSON); the UI edits the flat fields above. */
  data?: unknown;
  updatedAt?: number;
}

export interface ApiTaxonomyMetadata {
  id: string;
  userId?: string;
  title: string;
  description?: string;
  url?: string;
  domain?: string;
  /** Arbitrary capture payload (JSON); known keys are what the Admin captures list renders. */
  metadata?: {
    icon?: string;
    taxonomyId?: string;
    links?: { priority?: string; tags?: string[]; [key: string]: unknown };
    [key: string]: unknown;
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface HomepageTile {
  id: string;
  title: string;
  type: 'progress' | 'custom-todo' | 'recent-cities' | 'recent-pages' | 'progress-stats' | 'explore-map';
  position: number;
  visible: boolean;
  /** Per-tile options (opaque to the client today; tiles render from `type`). */
  config?: unknown;
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

export interface KnowledgeObject {
  id: string;
  userId?: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
  body?: string;
  links?: Array<{ kind: 'node' | 'object' | 'service' | 'url'; ref: string }>;
  visibility?: string;
  createdAt: number;
  updatedAt: number;
}