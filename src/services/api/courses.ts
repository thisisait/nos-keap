import { apiFetch } from './client';
import { UserProgress } from '../../types/database';

export interface CaptureStats {
  totalMetadata: number;
  domains: string[];
  lastUpdate: string;
}

export const coursesApi = {
  getCourses: () => apiFetch<UserProgress[]>('/api/courses'),
  updateProgress: (courseId: number, progress: number, completedChapters: number) =>
    apiFetch(`/api/courses/${courseId}/progress`, {
      method: 'POST',
      body: JSON.stringify({ progress, completedChapters }),
    }),
  getUserStats: () => apiFetch<CaptureStats>('/api/stats'),
};
