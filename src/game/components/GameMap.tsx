
import React, { useState, useEffect } from 'react';
import { GameNode } from '../types/taxonomy';
import { gameMap } from '../utils/taxonomyMapper';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDatabase } from '@/hooks/useDatabase';

interface GameMapProps {
  onNodeClick: (node: GameNode) => void;
  discoveredNodes: string[];
}

export const GameMap: React.FC<GameMapProps> = ({ onNodeClick, discoveredNodes }) => {
  const { getTaxonomyMetadata } = useDatabase();
  const [metadata, setMetadata] = useState<{ [key: string]: any }>({});

  useEffect(() => {
    // Load metadata for all islands
    const loadMetadata = async () => {
      const islandMetadata: { [key: string]: any } = {};
      for (const island of gameMap) {
        const meta = getTaxonomyMetadata(island.id);
        if (meta) {
          islandMetadata[island.id] = meta;
        }
      }
      setMetadata(islandMetadata);
    };
    
    loadMetadata();
  }, [getTaxonomyMetadata]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-foreground mb-2">
          Knowledge Galaxy
        </h1>
        <p className="text-muted-foreground">
          Choose a knowledge island to explore
        </p>
      </div>

      <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {gameMap.map((island) => {
          const _isDiscovered = discoveredNodes.includes(island.id);
          const isUnlocked = island.unlocked;
          const islandMeta = metadata[island.id];
          
          return (
            <Card 
              key={island.id}
              className={`game-card cursor-pointer transition-all duration-200 hover:scale-105 ${
                isUnlocked 
                  ? 'hover:shadow-lg border-game-primary/20' 
                  : 'opacity-50 cursor-not-allowed'
              }`}
              onClick={() => isUnlocked && onNodeClick(island)}
            >
              <CardHeader className="text-center">
                <CardTitle className="text-xl text-foreground">
                  {islandMeta?.name || island.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-center">
                <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center text-2xl ${
                  isUnlocked 
                    ? 'bg-game-primary text-white' 
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {islandMeta?.icon || '🏝️'}
                </div>
                {islandMeta?.description && (
                  <p className="text-sm text-muted-foreground mb-2">
                    {islandMeta.description}
                  </p>
                )}
                <p className="text-sm text-muted-foreground mb-4">
                  {island.children?.length || 0} cities to explore
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
