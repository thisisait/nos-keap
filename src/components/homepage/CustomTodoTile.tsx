import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { StickyNote, Plus, X } from 'lucide-react';

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface CustomTodoTileProps {
  title?: string;
  config?: any;
}

export const CustomTodoTile: React.FC<CustomTodoTileProps> = ({ 
  title = 'TODO poznámky',
  config = {}
}) => {
  const [todos, setTodos] = useState<TodoItem[]>([
    { id: '1', text: 'Dokončit kapitolu o algebře', completed: false },
    { id: '2', text: 'Přečíst článek o historii', completed: true },
  ]);
  const [newTodo, setNewTodo] = useState('');

  const addTodo = () => {
    if (newTodo.trim()) {
      const todo: TodoItem = {
        id: Date.now().toString(),
        text: newTodo.trim(),
        completed: false
      };
      setTodos([...todos, todo]);
      setNewTodo('');
    }
  };

  const toggleTodo = (id: string) => {
    setTodos(prev => prev.map(todo => 
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ));
  };

  const removeTodo = (id: string) => {
    setTodos(prev => prev.filter(todo => todo.id !== id));
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <StickyNote className="w-4 h-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {todos.map((todo) => (
            <div
              key={todo.id}
              className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 group"
            >
              <Checkbox
                checked={todo.completed}
                onCheckedChange={() => toggleTodo(todo.id)}
              />
              <span className={`flex-1 text-sm ${todo.completed ? 'line-through text-muted-foreground' : ''}`}>
                {todo.text}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeTodo(todo.id)}
                className="opacity-0 group-hover:opacity-100 h-6 w-6 p-0"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
        
        <div className="flex gap-2 pt-2 border-t border-border">
          <Input
            placeholder="Nová poznámka..."
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addTodo()}
            className="text-sm"
          />
          <Button onClick={addTodo} size="sm">
            <Plus className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};