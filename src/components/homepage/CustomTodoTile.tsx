import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { StickyNote, Plus, X } from 'lucide-react';
import { todosApi } from '@/services/api/todos';

interface CustomTodoTileProps {
  title?: string;
}

export const CustomTodoTile: React.FC<CustomTodoTileProps> = ({ title }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newTodo, setNewTodo] = useState('');

  const { data: todos = [] } = useQuery({ queryKey: ['todos'], queryFn: todosApi.getTodos });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['todos'] });
  const save = useMutation({ mutationFn: todosApi.saveTodo, onSettled: invalidate });
  const remove = useMutation({ mutationFn: todosApi.deleteTodo, onSettled: invalidate });

  const addTodo = () => {
    const text = newTodo.trim();
    if (!text) return;
    save.mutate({ id: crypto.randomUUID(), title: text, completed: false });
    setNewTodo('');
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <StickyNote className="w-4 h-4" />
          {title ?? t('tiles.todos.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {todos.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">{t('tiles.todos.empty')}</p>
          )}
          {todos.map((todo) => (
            <div
              key={todo.id}
              className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 group"
            >
              <Checkbox
                checked={todo.completed}
                onCheckedChange={() =>
                  save.mutate({ id: todo.id, title: todo.title, completed: !todo.completed })
                }
              />
              <span
                className={`flex-1 text-sm ${todo.completed ? 'line-through text-muted-foreground' : ''}`}
              >
                {todo.title}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate(todo.id)}
                aria-label={t('common.delete')}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 h-6 w-6 p-0"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2 border-t border-border">
          <Input
            placeholder={t('tiles.todos.placeholder')}
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTodo()}
            className="text-sm"
          />
          <Button onClick={addTodo} size="sm" aria-label={t('common.add')}>
            <Plus className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
