import React, { useState, useEffect } from 'react';
import { GameMap } from '@/game/components/GameMap';
import { CityView } from '@/game/components/CityView';
import { BuildingView } from '@/game/components/BuildingView';
import { GameNode, GameLevel } from '@/game/types/taxonomy';
import { gameMap } from '@/game/utils/taxonomyMapper';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Home, Settings } from 'lucide-react';
import { isUnlockAllEnabled } from '@/game/config/featureFlags';
import { Link } from 'react-router-dom';

const Game: React.FC = () => {
  const [currentLevel, setCurrentLevel] = useState<GameLevel>('island');
  const [currentNode, setCurrentNode] = useState<GameNode | null>(null);
  const [currentIsland, setCurrentIsland] = useState<GameNode | null>(null);
  const [discoveredNodes, setDiscoveredNodes] = useState<string[]>(
    isUnlockAllEnabled() 
      ? gameMap.flatMap(island => [
          island.id,
          ...(island.children?.map(city => city.id) || []),
          ...(island.children?.flatMap(city => city.children?.map(building => building.id) || []) || [])
        ])
      : ['01'] // First island discovered by default
  );
  const [breadcrumb, setBreadcrumb] = useState<GameNode[]>([]);
  const [completedItems, setCompletedItems] = useState<string[]>([]);

  const handleNodeClick = (node: GameNode) => {
    console.log('Node clicked:', node);
    
    if (node.unlocked || isUnlockAllEnabled()) {
      if (node.type === 'island') {
        // Navigate to island detail view (cities)
        setCurrentNode(node);
        setCurrentIsland(node);
        setCurrentLevel('city');
        setBreadcrumb([node]);
      } else if (node.type === 'city') {
        // Navigate to city detail view (buildings)
        setCurrentNode(node);
        setCurrentLevel('building');
        setBreadcrumb(prev => [...prev, node]);
      } else if (node.type === 'building') {
        // Open building detail with quests
        setCurrentNode(node);
        setBreadcrumb(prev => [...prev, node]);
      }

      // Discover adjacent nodes (only if feature flag is disabled)
      if (!isUnlockAllEnabled() && node.children) {
        const newDiscovered = node.children
          .filter(child => child.unlocked || Math.random() > 0.7) // Some discovery chance
          .map(child => child.id);
        setDiscoveredNodes(prev => [...new Set([...prev, ...newDiscovered])]);
      }
    }
  };

  const handleItemClick = (item: any) => {
    console.log('Item clicked:', item);
    // Toggle completion status for demo
    setCompletedItems(prev => 
      prev.includes(item.id) 
        ? prev.filter(id => id !== item.id)
        : [...prev, item.id]
    );
  };

  const handleBackNavigation = () => {
    if (breadcrumb.length === 0) return;
    
    if (currentLevel === 'city') {
      // Back to galaxy map
      setCurrentLevel('island');
      setCurrentNode(null);
      setCurrentIsland(null);
      setBreadcrumb([]);
    } else if (currentLevel === 'building') {
      // Back to city view
      setCurrentLevel('city');
      setCurrentNode(currentIsland);
      setBreadcrumb(prev => prev.slice(0, -1));
    }
  };

  const handleHomeNavigation = () => {
    setCurrentLevel('island');
    setCurrentNode(null);
    setCurrentIsland(null);
    setBreadcrumb([]);
  };

  const renderCurrentView = () => {
    if (currentLevel === 'island') {
      return (
        <GameMap
          onNodeClick={handleNodeClick}
          discoveredNodes={discoveredNodes}
        />
      );
    } else if (currentLevel === 'city' && currentIsland) {
      return (
        <CityView
          island={currentIsland}
          onNodeClick={handleNodeClick}
          discoveredNodes={discoveredNodes}
        />
      );
    } else if (currentLevel === 'building' && currentNode) {
      return (
        <BuildingView
          city={currentNode}
          onItemClick={handleItemClick}
          completedItems={completedItems}
        />
      );
    }

    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-foreground mb-4">Loading...</h2>
          <Button onClick={handleHomeNavigation} variant="outline" className="game-button-secondary">
            <Home className="w-4 h-4 mr-2" />
            Galaxy Map
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation header - Fixed positioning to avoid overlap */}
      {currentLevel !== 'island' && (
        <div className="fixed top-0 left-0 right-0 z-30 bg-card/80 backdrop-blur-sm border-b border-border">
          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-2">
              <Button
                onClick={handleBackNavigation}
                variant="outline"
                size="sm"
                className="game-button-secondary"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Zpět
              </Button>
              <Button
                onClick={handleHomeNavigation}
                variant="outline"
                size="sm"
                className="game-button-secondary"
              >
                <Home className="w-4 h-4" />
              </Button>
              <Link to="/">
                <Button
                  variant="outline"
                  size="sm"
                  className="game-button-secondary"
                >
                  <Home className="w-4 h-4 mr-2" />
                  Domů
                </Button>
              </Link>
              <Link to="/admin">
                <Button
                  variant="outline"
                  size="sm"
                  className="game-button-secondary"
                  title="Administrace"
                >
                  <Settings className="w-4 h-4" />
                </Button>
              </Link>
            </div>

            {/* Breadcrumb */}
            {breadcrumb.length > 0 && (
              <div className="bg-muted/50 border border-border rounded-full px-4 py-2">
                <div className="flex items-center text-foreground text-sm">
                  <span className="text-muted-foreground">Galaxie</span>
                  {breadcrumb.map((node, index) => (
                    <React.Fragment key={node.id}>
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span>{node.name}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content with top padding when navigation is present */}
      <div className={currentLevel !== 'island' ? 'pt-20' : ''}>
        {renderCurrentView()}
      </div>
    </div>
  );
};

export default Game;
