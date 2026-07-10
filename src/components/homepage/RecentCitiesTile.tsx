import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { activityApi } from '@/services/api/activity';

interface RecentCitiesTileProps {
  title?: string;
}

/** Real recent activity (the old tile rendered a hardcoded city list). */
export const RecentCitiesTile: React.FC<RecentCitiesTileProps> = ({ title }) => {
  const { t, i18n } = useTranslation();

  const { data: activity = [] } = useQuery({
    queryKey: ['recent-activity'],
    queryFn: () => activityApi.getRecentActivity(undefined, 5),
  });

  const linkFor = (itemType: string, itemId: string) =>
    itemType === 'city' || itemType === 'island' || itemType === 'building'
      ? `/game/${itemType}/${itemId}`
      : null;

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="w-4 h-4" />
          {title ?? t('tiles.recentActivity.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {activity.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">{t('tiles.recentActivity.empty')}</p>
        )}
        {activity.map((entry) => {
          const link = linkFor(entry.item_type, entry.item_id);
          const body = (
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{entry.item_id}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(entry.timestamp * 1000).toLocaleString(i18n.language)}
              </div>
            </div>
          );
          return link ? (
            <Link
              key={entry.id}
              to={link}
              className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 transition-colors"
            >
              {body}
            </Link>
          ) : (
            <div key={entry.id} className="flex items-center justify-between p-2 rounded-md">
              {body}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
};
