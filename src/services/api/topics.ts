import { apiFetch } from './client';

/** One admin topic row (topic_clusters) — the full row sans warm-start centroid
 *  (768 floats, pipeline-only). Mirrors server/topics-routes.ts toApi(). */
export interface AdminTopic {
  id: string;
  label: string;
  labelAuto: string;
  labelLocked: boolean;
  terms: string[];
  churnAccum: number;
  theta: number;
  memberCount: number;
  emptyRuns: number;
  model: string;
  updatedAt: number;
}

/** Topics-mode summary (db.topicStats()). */
export interface TopicStats {
  available: boolean;
  k: number;
  assigned: number;
  lastRunAt: number | null;
}

export interface AdminTopicsPayload {
  topics: AdminTopic[];
  stats: TopicStats;
}

/** One clustering run result (POST rebuild?wait=1 — server/topics.ts). */
export interface TopicRunResult {
  ok: boolean;
  skipped?: 'no-vectors' | 'too-few';
  k: number;
  n: number;
  moved: number;
  born: string[];
  retired: string[];
  ms: number;
}

export const topicsApi = {
  list: () => apiFetch<AdminTopicsPayload>('/api/admin/topics'),

  /** `label` string locks a custom label; `null` unlocks + restores label_auto. */
  rename: (id: string, label: string | null) =>
    apiFetch<AdminTopic>(`/api/admin/topics/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),

  reanchor: (id: string) =>
    apiFetch<AdminTopic>(`/api/admin/topics/${encodeURIComponent(id)}/reanchor`, {
      method: 'POST',
    }),

  /** Default fire-and-forget (202 {scheduled:true}); `wait` awaits the run. */
  rebuild: (opts: { reset?: boolean; wait?: boolean } = {}) =>
    apiFetch<TopicRunResult | { scheduled: true }>(
      `/api/admin/topics/rebuild${opts.wait ? '?wait=1' : ''}`,
      { method: 'POST', body: JSON.stringify({ reset: Boolean(opts.reset) }) },
    ),
};
