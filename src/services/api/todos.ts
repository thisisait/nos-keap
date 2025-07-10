import { TodoItem } from '../../types/database';

export const todosApi = {
  getTodos: async (): Promise<TodoItem[]> => {
    const response = await fetch('/api/todos');
    if (!response.ok) throw new Error('Failed to fetch todos');
    return response.json();
  },

  saveTodo: async (todo: TodoItem) => {
    const response = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(todo)
    });
    if (!response.ok) throw new Error('Failed to save todo');
  },

  deleteTodo: async (id: string) => {
    const response = await fetch(`/api/todos/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete todo');
  }
};