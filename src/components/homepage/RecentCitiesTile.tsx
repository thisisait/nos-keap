import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';

interface RecentCity {
  id: string;
  name: string;
  lastVisited: string;
  progress: number;
}

interface RecentCitiesTileProps {
  title?: string;
  config?: any;
}

export const RecentCitiesTile: React.FC<RecentCitiesTileProps> = ({ 
  title = 'Poslední navštívená města',
  config = {}
}) => {
  // Recent cities data from database
  const recentCities: RecentCity[] = [
    { id: 'math', name: 'Matematika', lastVisited: '2024-01-09', progress: 85 },
    { id: 'science', name: 'Přírodní vědy', lastVisited: '2024-01-08', progress: 67 },
    { id: 'history', name: 'Historie', lastVisited: '2024-01-07', progress: 34 },
  ];

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="w-4 h-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {recentCities.map((city) => (
          <Link
            key={city.id}
            to={`/game/city/${city.id}`}
            className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 transition-colors block"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{city.name}</div>
              <div className="text-xs text-muted-foreground">
                {city.lastVisited} • {city.progress}% dokončeno
              </div>
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
};