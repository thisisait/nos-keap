import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, CheckCircle2, Bookmark, ListTodo } from 'lucide-react';
import { completionApi } from '@/services/api/completion';
import { coursesApi } from '@/services/api/courses';
import { todosApi } from '@/services/api/todos';

interface ProgressStatsTileProps {
  title?: string;
}

/**
 * Real numbers only (the old tile rendered hardcoded fictional stats):
 * completed taxonomy items, captured pages, open todos.
 */
export const ProgressStatsTile: React.FC<ProgressStatsTileProps> = ({ title }) => {
  const { t } = useTranslation();

  const { data: completed = [] } = useQuery({
    queryKey: ['completed-items'],
    queryFn: completionApi.getCompletedItems,
  });
  const { data: captureStats } = useQuery({
    queryKey: ['capture-stats'],
    queryFn: coursesApi.getUserStats,
  });
  const { data: todos = [] } = useQuery({ queryKey: ['todos'], queryFn: todosApi.getTodos });

  const openTodos = todos.filter((todo) => !todo.completed).length;

  const rows = [
    { icon: CheckCircle2, value: completed.length, label: t('tiles.progress.completedItems') },
    { icon: Bookmark, value: captureStats?.totalMetadata ?? 0, label: t('tiles.progress.capturedPages') },
    { icon: ListTodo, value: openTodos, label: t('tiles.progress.openTodos') },
  ];

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="w-4 h-4" />
          {title ?? t('tiles.progress.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {rows.map(({ icon: Icon, value, label }) => (
            <div key={label} className="flex items-center gap-3">
              <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
              <span className="text-sm text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
