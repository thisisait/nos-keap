import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useDatabase } from '../hooks/useDatabase';
import { RecentPagesTile } from "@/components/homepage/RecentPagesTitle";
import { RecentCitiesTile } from "@/components/homepage/RecentCitiesTile";
import { CustomTodoTile } from "@/components/homepage/CustomTodoTile";
import { ProgressStatsTile } from "@/components/homepage/ProgressStatsTile";
import { Settings, Play, Globe, Satellite } from 'lucide-react';
import { useToast } from "@/hooks/use-toast";

const Index = () => {
  const { isInitialized, saveTaxonomyMetadata } = useDatabase();
  const { toast } = useToast();
  const [companionConnected, setCompanionConnected] = useState(false);
  
  // Companion panel komunikace
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'DH_SAVE_METADATA') {
        const metadata = event.data.data;
        
        // Konverze companion dat do taxonomie formátu
        const taxonomyMetadata = {
          id: `companion_${metadata.id}`,
          name: metadata.title,
          description: metadata.description,
          icon: getCategoryIcon(metadata.category),
          links: JSON.stringify({
            url: metadata.url,
            domain: metadata.domain,
            priority: metadata.priority,
            tags: metadata.tags,
            savedAt: metadata.savedAt
          }),
          translations: JSON.stringify({})
        };

        saveTaxonomyMetadata(taxonomyMetadata);
        
        toast({
          title: "✅ Data přijata z Companion panelu",
          description: `Uloženo: ${metadata.title}`,
        });
        
        setCompanionConnected(true);
        setTimeout(() => setCompanionConnected(false), 3000);
      }
      
      if (event.data.type === 'DH_COMPANION_DATA') {
        toast({
          title: "🔗 Companion panel připojen",
          description: `Nalezeno ${event.data.data.length} záznamů`,
        });
        setCompanionConnected(true);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [saveTaxonomyMetadata, toast]);

  const getCategoryIcon = (category: string) => {
    const icons: { [key: string]: string } = {
      '01_natural_sciences': '🔬',
      '02_formal_sciences': '📊', 
      '03_social_sciences': '👥',
      '04_humanities': '📚',
      '05_technology': '💻',
      '06_arts': '🎨'
    };
    return icons[category] || '📄';
  };

  // Mock homepage tiles configuration - would come from database
  const enabledTiles = [
    { id: '1', type: 'progress-stats', title: 'Statistiky pokroku', visible: true },
    { id: '2', type: 'recent-cities', title: 'Poslední navštívená města', visible: true },
    { id: '3', type: 'recent-pages', title: 'Naposledy aktualizované', visible: true },
    { id: '4', type: 'custom-todo', title: 'TODO poznámky', visible: true },
  ];

  const renderTile = (tile: any) => {
    switch (tile.type) {
      case 'progress-stats':
        return <ProgressStatsTile key={tile.id} title={tile.title} />;
      case 'recent-cities':
        return <RecentCitiesTile key={tile.id} title={tile.title} />;
      case 'recent-pages':
        return <RecentPagesTile key={tile.id} title={tile.title} />;
      case 'custom-todo':
        return <CustomTodoTile key={tile.id} title={tile.title} />;
      default:
        return null;
    }
  };

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Globe className="w-8 h-8 mx-auto mb-2 text-muted-foreground animate-pulse" />
          <p className="text-muted-foreground">Načítám aplikaci...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <Globe className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">IIAB Learning</h1>
              <p className="text-sm text-muted-foreground">Internet in a Box</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {companionConnected && (
              <div className="flex items-center gap-1 text-sm text-green-600 font-medium">
                <Satellite className="w-4 h-4" />
                Companion připojen
              </div>
            )}
            <Link to="/game">
              <Button className="flex items-center gap-2">
                <Play className="w-4 h-4" />
                Začít učení
              </Button>
            </Link>
            <Link to="/admin">
              <Button variant="outline" size="icon">
                <Settings className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground mb-2">Úvodní stránka</h2>
          <p className="text-muted-foreground">
            Vítejte ve vašem osobním vzdělávacoím centru. Konfigurace se upravuje v administraci.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {enabledTiles
            .filter(tile => tile.visible)
            .map(tile => renderTile(tile))
          }
        </div>
      </main>
    </div>
  );
};

export default Index;