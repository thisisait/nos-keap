import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock } from 'lucide-react';

interface RecentPage {
  id: string;
  title: string;
  lastVisited: string;
  path: string;
}

interface RecentPagesTileProps {
  title?: string;
  config?: any;
}

export const RecentPagesTile: React.FC<RecentPagesTileProps> = ({ 
  title = 'Naposledy aktualizované stránky',
  config = {}
}) => {
  // Recent pages data from database
  const recentPages: RecentPage[] = [
    { id: '1', title: 'Základy algebry', lastVisited: '2024-01-09', path: '/game/building/math-algebra' },
    { id: '2', title: 'Historie světa', lastVisited: '2024-01-08', path: '/game/building/history-world' },
    { id: '3', title: 'Fyzika pohybu', lastVisited: '2024-01-07', path: '/game/building/physics-motion' },
  ];

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-4 h-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {recentPages.map((page) => (
          <div
            key={page.id}
            className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{page.title}</div>
              <div className="text-xs text-muted-foreground">{page.lastVisited}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
};