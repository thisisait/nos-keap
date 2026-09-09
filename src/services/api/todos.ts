/**
 * Todos adapter — the old todos entity died in migration 010; todos are rows
 * in the caller's own private 'todos-<uid>' DataTable. This keeps the old
 * call signatures (tile + stats consumers unchanged) and maps them onto the
 * plain tables surface; /api/todos-table is the one idempotent ensure.
 */
import { apiFetch } from './client';
import { tablesApi } from './tables';
import type { TableInfo } from '../../../shared/contracts/table';
import { TodoItem } from '../../types/database';

let ensured: Promise<TableInfo> | null = null;
const table = (): Promise<TableInfo> => {
  ensured ??= apiFetch<TableInfo>('/api/todos-table').catch((e) => {
    ensured = null; // a failed ensure must not poison every later call
    throw e;
  });
  return ensured;
};

export const todosApi = {
  getTodos: async (): Promise<TodoItem[]> => {
    const t = await table();
    const { rows } = await tablesApi.rows(t.id, { limit: 200 });
    return rows
      .map((r) => ({
        id: r.id,
        title: String(r.values.title ?? ''),
        completed: Boolean(r.values.completed),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  saveTodo: async (todo: Pick<TodoItem, 'id' | 'title'> & Partial<TodoItem>) => {
    const t = await table();
    await tablesApi.upsertRow(t.id, todo.id, {
      title: todo.title,
      completed: Boolean(todo.completed),
    });
  },
  deleteTodo: async (id: string) => {
    const t = await table();
    await tablesApi.deleteRow(t.id, id);
  },
};
