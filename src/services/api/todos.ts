import { apiFetch } from './client';
import { TodoItem } from '../../types/database';

export const todosApi = {
  getTodos: () => apiFetch<TodoItem[]>('/api/todos'),
  saveTodo: (todo: Pick<TodoItem, 'id' | 'title'> & Partial<TodoItem>) =>
    apiFetch('/api/todos', { method: 'POST', body: JSON.stringify(todo) }),
  deleteTodo: (id: string) =>
    apiFetch(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
