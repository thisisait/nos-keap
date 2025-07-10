
import React, { useState, useEffect } from 'react';
import { GameNode } from '../types/taxonomy';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDatabase } from '@/hooks/useDatabase';

interface BuildingViewProps {
  city: GameNode;
  onItemClick?: (item: any) => void;
  completedItems: string[];
}

export const BuildingView: React.FC<BuildingViewProps> = ({ city, onItemClick, completedItems = [] }) => {
  const buildings = city.children || [];
  const { getTaxonomyMetadata } = useDatabase();
  const [metadata, setMetadata] = useState<{ [key: string]: any }>({});

  useEffect(() => {
    // Load metadata for all buildings and items
    const loadMetadata = async () => {
      const buildingMetadata: { [key: string]: any } = {};
      for (const building of buildings) {
        const meta = getTaxonomyMetadata(building.id);
        if (meta) {
          buildingMetadata[building.id] = meta;
        }
        // Load metadata for items too
        if (building.items) {
          for (const item of building.items) {
            const itemMeta = getTaxonomyMetadata(item.id);
            if (itemMeta) {
              buildingMetadata[item.id] = itemMeta;
            }
          }
        }
      }
      setMetadata(buildingMetadata);
    };
    
    loadMetadata();
  }, [buildings, getTaxonomyMetadata]);

  const handleItemClick = (item: any) => {
    onItemClick?.(item);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-secondary/20 p-6">
      {/* City title */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-foreground mb-2">
          {city.name}
        </h1>
        <p className="text-muted-foreground">Select topics to learn</p>
      </div>

      {/* Buildings grid */}
      <div className="max-w-6xl mx-auto space-y-8">
        {buildings.map((building) => (
          <Card key={building.id} className="bg-card/80 backdrop-blur-sm border-border">
            <CardHeader>
              <CardTitle className="text-2xl text-foreground">
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
                  const isAvailable = true; // Simplified - all items available
                  const itemMeta = metadata[item.id];
                  
                  return (
                    <div
                      key={item.id}
                      className={`p-4 rounded-lg border transition-all duration-200 cursor-pointer hover:scale-105 ${
                        isCompleted 
                          ? 'bg-primary/10 border-primary shadow-md' 
                          : 'bg-muted/30 border-border hover:border-primary/50'
                      }`}
                      onClick={() => isAvailable && handleItemClick(item)}
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
                            {itemMeta?.description || item.description || 'No description available'}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Progress indicator */}
              <div className="mt-6 pt-4 border-t border-border">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground">Progress</span>
                  <span className="text-foreground font-medium">
                    {building.items?.filter(item => completedItems.includes(item.id)).length || 0}/{building.items?.length || 0}
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2 mt-2">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300"
                    style={{ 
                      width: `${building.items?.length ? 
                        (building.items.filter(item => completedItems.includes(item.id)).length / building.items.length) * 100 : 0}%` 
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
