import { UserProgress } from '../../types/database';

export const coursesApi = {
  getCourses: async (): Promise<UserProgress[]> => {
    const response = await fetch('/api/courses');
    if (!response.ok) throw new Error('Failed to fetch courses');
    return response.json();
  },

  updateProgress: async (courseId: number, progress: number, completedChapters: number) => {
    const response = await fetch(`/api/courses/${courseId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress, completedChapters })
    });
    if (!response.ok) throw new Error('Failed to update progress');
  },

  getUserStats: async () => {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error('Failed to fetch stats');
    return response.json();
  }
};