
import React, { useState, useEffect } from 'react';
import { GameNode } from '../types/taxonomy';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDatabase } from '@/hooks/useDatabase';

interface CityViewProps {
  island: GameNode;
  onNodeClick: (node: GameNode) => void;
  discoveredNodes: string[];
}

export const CityView: React.FC<CityViewProps> = ({ island, onNodeClick, discoveredNodes }) => {
  const cities = island.children || [];
  const { getTaxonomyMetadata } = useDatabase();
  const [metadata, setMetadata] = useState<{ [key: string]: any }>({});

  useEffect(() => {
    // Load metadata for all cities
    const loadMetadata = async () => {
      const cityMetadata: { [key: string]: any } = {};
      for (const city of cities) {
        const meta = getTaxonomyMetadata(city.id);
        if (meta) {
          cityMetadata[city.id] = meta;
        }
      }
      setMetadata(cityMetadata);
    };
    
    loadMetadata();
  }, [cities, getTaxonomyMetadata]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-foreground mb-2">
          {island.name}
        </h1>
        <p className="text-muted-foreground">
          Choose a city to explore its knowledge areas
        </p>
      </div>

      <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {cities.map((city) => {
          const isDiscovered = discoveredNodes.includes(city.id);
          const isUnlocked = city.unlocked;
          const cityMeta = metadata[city.id];
          
          return (
            <Card 
              key={city.id}
              className={`game-card cursor-pointer transition-all duration-200 hover:scale-105 ${
                isUnlocked 
                  ? 'hover:shadow-lg border-game-primary/20' 
                  : 'opacity-50 cursor-not-allowed'
              }`}
              onClick={() => isUnlocked && onNodeClick(city)}
            >
              <CardHeader className="text-center">
                <CardTitle className="text-xl text-foreground">
                  {cityMeta?.name || city.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-center">
                <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center text-2xl ${
                  isUnlocked 
                    ? 'bg-game-primary text-white' 
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {cityMeta?.icon || '🏢'}
                </div>
                {cityMeta?.description && (
                  <p className="text-sm text-muted-foreground mb-2">
                    {cityMeta.description}
                  </p>
                )}
                <p className="text-sm text-muted-foreground mb-4">
                  {city.children?.length || 0} buildings to explore
                </p>
                <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                  isUnlocked 
                    ? 'bg-game-success/20 text-game-success' 
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {isUnlocked ? 'Available' : 'Locked'}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
