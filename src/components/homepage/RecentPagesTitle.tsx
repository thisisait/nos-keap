import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock, ExternalLink } from 'lucide-react';
import { metadataApi } from '@/services/api/metadata';

interface RecentPagesTileProps {
  title?: string;
}

/** Real captured pages (the old tile rendered a hardcoded list). */
export const RecentPagesTile: React.FC<RecentPagesTileProps> = ({ title }) => {
  const { t, i18n } = useTranslation();

  const { data: captures = [] } = useQuery({
    queryKey: ['captures'],
    queryFn: metadataApi.getAllMetadata,
  });

  const recent = captures.slice(0, 5);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-4 h-4" />
          {title ?? t('tiles.recentPages.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {recent.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">{t('tiles.recentPages.empty')}</p>
        )}
        {recent.map((page) => (
          <a
            key={page.id}
            href={page.url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center justify-between gap-2 p-2 rounded-md transition-colors ${page.url ? 'hover:bg-muted/50' : 'pointer-events-none'}`}
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{page.title}</div>
              <div className="text-xs text-muted-foreground truncate">
                {page.domain ?? ''}
                {page.domain ? ' • ' : ''}
                {new Date(page.updatedAt * 1000).toLocaleDateString(i18n.language)}
              </div>
            </div>
            {page.url && <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0" />}
          </a>
        ))}
      </CardContent>
    </Card>
  );
};
