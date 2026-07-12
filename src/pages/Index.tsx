import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useServerHealth } from '../hooks/useServerHealth';
import { homepageApi } from '../services/api/homepage';
import { RecentPagesTile } from '@/components/homepage/RecentPagesTitle';
import { RecentCitiesTile } from '@/components/homepage/RecentCitiesTile';
import { CustomTodoTile } from '@/components/homepage/CustomTodoTile';
import { ProgressStatsTile } from '@/components/homepage/ProgressStatsTile';
import { ExploreMapTile } from '@/components/homepage/ExploreMapTile';
import { Settings, Play, Globe, Table2 } from 'lucide-react';
import type { HomepageTile } from '../types/database';

/** Shown until the user configures their own set in Administration. */
const DEFAULT_TILES: HomepageTile[] = [
  { id: 'default-progress', type: 'progress-stats', title: '', position: 0, visible: true },
  { id: 'default-pages', type: 'recent-pages', title: '', position: 1, visible: true },
  { id: 'default-todos', type: 'custom-todo', title: '', position: 3, visible: true },
  { id: 'default-explore', type: 'explore-map', title: '', position: 4, visible: true },
];

const Index = () => {
  const { t } = useTranslation();
  const { isInitialized } = useServerHealth();

  // The configured tiles are real data now — the old page ignored them and
  // rendered a hardcoded array (REVIEW.md §3).
  const { data: configuredTiles } = useQuery({
    queryKey: ['homepage-tiles'],
    queryFn: homepageApi.getHomepageTiles,
    enabled: isInitialized,
  });

  const tiles = configuredTiles?.length ? configuredTiles : DEFAULT_TILES;

  const renderTile = (tile: HomepageTile) => {
    const title = tile.title || undefined;
    switch (tile.type) {
      case 'progress-stats':
        return <ProgressStatsTile key={tile.id} title={title} />;
      case 'recent-cities':
        return <RecentCitiesTile key={tile.id} title={title} />;
      case 'recent-pages':
        return <RecentPagesTile key={tile.id} title={title} />;
      case 'custom-todo':
        return <CustomTodoTile key={tile.id} title={title} />;
      case 'explore-map':
        return <ExploreMapTile key={tile.id} title={title} />;
      default:
        return null;
    }
  };

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Globe className="w-8 h-8 mx-auto mb-2 text-muted-foreground animate-pulse motion-reduce:animate-none" />
          <p className="text-muted-foreground">{t('app.connecting')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <Globe className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">{t('app.name')}</h1>
              <p className="text-sm text-muted-foreground">{t('app.tagline')}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link to="/explore">
              <Button className="flex items-center gap-2">
                <Play className="w-4 h-4" />
                {t('index.startExploring')}
              </Button>
            </Link>
            <Link to="/tables" aria-label={t('tables.title')}>
              <Button variant="outline" size="icon">
                <Table2 className="w-4 h-4" />
              </Button>
            </Link>
            <Link to="/admin" aria-label={t('index.administration')}>
              <Button variant="outline" size="icon">
                <Settings className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight text-foreground mb-2">{t('index.heading')}</h2>
          <p className="text-muted-foreground">{t('index.welcome')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tiles
            .filter((tile) => tile.visible)
            .sort((a, b) => a.position - b.position)
            .map(renderTile)}
        </div>
      </main>
    </div>
  );
};

export default Index;
