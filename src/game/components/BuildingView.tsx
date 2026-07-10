import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { GameNode } from '../types/taxonomy';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';
import { taxonomyApi } from '@/services/api/taxonomy';
import { useNosConfig, resolveRequiredData } from '@/config/nos';
import type { TaxonomyMetadata } from '@/types/database';

interface BuildingViewProps {
  city: GameNode;
  onItemClick?: (item: any) => void;
  completedItems: string[];
}

export const BuildingView: React.FC<BuildingViewProps> = ({
  city,
  onItemClick,
  completedItems = [],
}) => {
  const { t } = useTranslation();
  const buildings = city.children || [];
  const nosConfig = useNosConfig();

  // One batched request for ALL curated metadata, indexed by node id. The old
  // version fired one un-awaited call per node and tested the Promise for
  // truthiness — the curated overlay (the app's headline feature) never
  // rendered (REVIEW.md §5 async-as-sync bug class).
  const { data: metadata = {} } = useQuery({
    queryKey: ['taxonomy-metadata'],
    queryFn: async () => {
      const rows = (await taxonomyApi.getTaxonomyMetadata()) as TaxonomyMetadata[];
      return Object.fromEntries(rows.map((row) => [row.id, row]));
    },
  });

  const handleItemClick = (item: any) => {
    onItemClick?.(item);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-secondary/20 p-6">
      {/* City title */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">{city.name}</h1>
        <p className="text-muted-foreground">{t('game.selectTopics')}</p>
      </div>

      {/* Buildings grid */}
      <div className="max-w-6xl mx-auto space-y-8">
        {buildings.map((building) => (
          <Card key={building.id} className="bg-card/80 backdrop-blur-sm border-border">
            <CardHeader>
              <CardTitle className="text-2xl tracking-tight text-foreground">
                {metadata[building.id]?.name || building.name}
              </CardTitle>
              {metadata[building.id]?.description && (
                <p className="text-muted-foreground">{metadata[building.id].description}</p>
              )}
            </CardHeader>
            <CardContent>
              {/* Items grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {building.items?.map((item) => {
                  const isCompleted = completedItems.includes(item.id);
                  const itemMeta = metadata[item.id];
                  // Curated content ref overrides the static dataset's.
                  const contentLink = resolveRequiredData(
                    itemMeta?.requiredData ?? item.requiredData,
                    nosConfig,
                  );

                  return (
                    <div
                      key={item.id}
                      className={`p-4 rounded-lg border transition-all duration-200 cursor-pointer hover:scale-[1.02] motion-reduce:hover:scale-100 ${
                        isCompleted
                          ? 'bg-primary/10 border-primary shadow-md'
                          : 'bg-muted/30 border-border hover:border-primary/50'
                      }`}
                      onClick={() => handleItemClick(item)}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={isCompleted}
                          className="mt-1"
                          onChange={() => {}} // Controlled by parent click
                        />
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-foreground text-sm leading-tight mb-1">
                            {itemMeta?.name || item.name}
                          </h4>
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {itemMeta?.description || item.description || t('game.noDescription')}
                          </p>
                          {contentLink && (
                            <Button
                              asChild
                              variant="outline"
                              size="sm"
                              className="mt-2 h-7 text-xs"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <a href={contentLink.url} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="w-3 h-3 mr-1" />
                                {t('content.openIn', {
                                  service: contentLink.service.label.split(' (')[0],
                                })}
                              </a>
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Progress indicator */}
              <div className="mt-6 pt-4 border-t border-border">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">{t('game.progress')}</span>
                  <span className="text-foreground font-medium tabular-nums">
                    {building.items?.filter((item) => completedItems.includes(item.id)).length || 0}/
                    {building.items?.length || 0}
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2 mt-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300 motion-reduce:transition-none"
                    style={{
                      width: `${
                        building.items?.length
                          ? (building.items.filter((item) => completedItems.includes(item.id)).length /
                              building.items.length) *
                            100
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};
