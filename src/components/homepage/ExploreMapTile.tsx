import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Telescope, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/services/api/client';
import { type GraphPayload } from '@/hooks/useExplorerData';

interface ExploreMapTileProps {
  title?: string;
}

/** Entry point to /explore — shows how much of the corpus is embedded. */
export const ExploreMapTile: React.FC<ExploreMapTileProps> = ({ title }) => {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['graph'],
    queryFn: () => apiFetch<GraphPayload>('/api/graph'),
    staleTime: 5 * 60 * 1000,
  });

  const nodes = data?.nodes?.length ?? 0;
  const embedded = data?.meta?.embeddings?.total ?? 0;

  return (
    <Link to="/explore" className="group">
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Telescope className="h-4 w-4 text-primary" />
            {title || t('tiles.exploreMap.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('tiles.exploreMap.subtitle')}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('tiles.exploreMap.stats', { nodes, embedded })}
          </p>
          <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary">
            {t('tiles.exploreMap.cta')}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
};
