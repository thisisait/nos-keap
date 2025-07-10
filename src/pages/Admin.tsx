import React, { useState, useEffect } from 'react';
import { useDatabase } from '@/hooks/useDatabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { TaxonomySelect } from '@/components/TaxonomySelect';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Save, Settings, Database, Plus, Edit, Trash, Cog, ExternalLink, Globe } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

interface TaxonomyMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  links: string;
  translations: string;
}

interface HomepageTile {
  id: string;
  type: string;
  title: string;
  enabled: boolean;
  position: number;
  config: string;
}

interface ApiMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  taxonomyId?: string;
  links: any;
  translations: any;
  createdAt?: string;
  updatedAt?: string;
}

export default function Admin() {
  const { 
    isInitialized, 
    getTaxonomyMetadata, 
    saveTaxonomyMetadata: saveTaxonomyMetadataDB,
    deleteTaxonomyMetadata,
    getHomepageTiles,
    saveHomepageTiles: saveHomepageTilesDB,
    getAllMetadataApi
  } = useDatabase();
  const { toast } = useToast();
  
  const [taxonomyItems, setTaxonomyItems] = useState<TaxonomyMetadata[]>([]);
  const [homepageTiles, setHomepageTiles] = useState<HomepageTile[]>([]);
  const [apiMetadata, setApiMetadata] = useState<ApiMetadata[]>([]);
  const [editingItem, setEditingItem] = useState<TaxonomyMetadata | null>(null);
  const [selectedTaxonomyId, setSelectedTaxonomyId] = useState<string | null>(null);
  const [newTile, setNewTile] = useState({ type: 'recent-pages', title: '', enabled: true });

  const loadData = () => {
    try {
      const taxonomyData = getTaxonomyMetadata() as TaxonomyMetadata[];
      setTaxonomyItems(taxonomyData || []);
      
      const tilesData = getHomepageTiles();
      setHomepageTiles(tilesData || []);

      const apiData = getAllMetadataApi();
      setApiMetadata(apiData || []);
    } catch (error) {
      console.error('Error loading data:', error);
      toast({
        title: "Chyba",
        description: "Nepodařilo se načíst data z databáze",
        variant: "destructive"
      });
    }
  };

  const createNewTaxonomyItem = () => {
    if (!selectedTaxonomyId) {
      toast({
        title: "Chyba",
        description: "Nejdříve vyberte položku z taxonomie",
        variant: "destructive"
      });
      return;
    }

    const existingItem = taxonomyItems.find(item => item.id === selectedTaxonomyId);
    if (existingItem) {
      setEditingItem(existingItem);
    } else {
      setEditingItem({
        id: selectedTaxonomyId,
        name: '',
        description: '',
        icon: '',
        links: '{}',
        translations: '{}'
      });
    }
  };

  const saveTaxonomyMetadata = async () => {
    if (!editingItem || !editingItem.id || !editingItem.name) {
      toast({
        title: "Chyba",
        description: "ID a název jsou povinné",
        variant: "destructive"
      });
      return;
    }

    try {
      await saveTaxonomyMetadataDB(editingItem);
      
      // Reload data from database
      loadData();

      toast({
        title: "Úspěch",
        description: "Metadata byla uložena"
      });
      
      setEditingItem(null);
      setSelectedTaxonomyId(null);
    } catch (error) {
      console.error('Error saving taxonomy metadata:', error);
      toast({
        title: "Chyba",
        description: "Nepodařilo se uložit metadata",
        variant: "destructive"
      });
    }
  };

  const deleteTaxonomyItem = (id: string) => {
    try {
      deleteTaxonomyMetadata(id);
      setTaxonomyItems(prev => prev.filter(item => item.id !== id));
      
      toast({
        title: "Úspěch", 
        description: "Metadata byla smazána"
      });
    } catch (error) {
      console.error('Error deleting taxonomy metadata:', error);
      toast({
        title: "Chyba",
        description: "Nepodařilo se smazat metadata",
        variant: "destructive"
      });
    }
  };

  const saveHomepageTiles = async () => {
    try {
      await saveHomepageTilesDB(homepageTiles);
      toast({
        title: "Úspěch",
        description: "Konfigurace homepage byla uložena"
      });
    } catch (error) {
      console.error('Error saving homepage tiles:', error);
      toast({
        title: "Chyba", 
        description: "Nepodařilo se uložit konfiguraci",
        variant: "destructive"
      });
    }
  };

  const addHomepageTile = () => {
    const tile: HomepageTile = {
      id: Date.now().toString(),
      type: newTile.type,
      title: newTile.title || getTileDefaultTitle(newTile.type),
      enabled: true,
      position: homepageTiles.length,
      config: '{}'
    };
    setHomepageTiles([...homepageTiles, tile]);
    setNewTile({ type: 'recent-pages', title: '', enabled: true });
  };

  const getTileDefaultTitle = (type: string) => {
    switch (type) {
      case 'recent-pages': return 'Naposledy aktualizované stránky';
      case 'recent-cities': return 'Poslední navštívená města';
      case 'custom-todo': return 'TODO poznámky';
      case 'progress-stats': return 'Statistiky pokroku';
      default: return 'Nová dlaždice';
    }
  };

  const toggleTile = (id: string) => {
    setHomepageTiles(prev => 
      prev.map(tile => 
        tile.id === id ? { ...tile, enabled: !tile.enabled } : tile
      )
    );
  };

  useEffect(() => {
    if (isInitialized) {
      loadData();
    }
  }, [isInitialized]);

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Database className="w-8 h-8 mx-auto mb-2 text-muted-foreground animate-pulse" />
          <p className="text-muted-foreground">Načítám databázi...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 text-foreground hover:text-primary">
              <ArrowLeft className="w-4 h-4" />
              Zpět na úvodní stránku
            </Link>
            <h1 className="text-lg font-semibold">Administrace</h1>
          </div>
          <Link to="/settings">
            <Button variant="ghost" size="sm" className="flex items-center gap-2">
              <Cog className="w-4 h-4" />
              Nastavení
            </Button>
          </Link>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6">
        <Tabs defaultValue="api-data" className="space-y-6">
          <TabsList className="w-full max-w-xl">
            <TabsTrigger value="api-data" className="flex-1">API Data</TabsTrigger>
            <TabsTrigger value="homepage" className="flex-1">Homepage</TabsTrigger>
            <TabsTrigger value="taxonomy" className="flex-1">Taxonomie</TabsTrigger>
          </TabsList>

          <TabsContent value="api-data" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="w-5 h-5" />
                  Metadata z Companion API
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {apiMetadata.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Database className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>Žádná metadata z companion scriptu zatím nejsou uložena</p>
                      <p className="text-sm">Data se objeví po prvním použití companion panelu</p>
                    </div>
                  ) : (
                    <div className="grid gap-4">
                      {apiMetadata.map((item) => (
                        <Card key={item.id} className="border-l-4 border-l-primary">
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="text-lg">{item.icon || '📎'}</span>
                                  <h3 className="font-semibold">{item.name}</h3>
                                  {item.taxonomyId && (
                                    <Badge variant="secondary">{item.taxonomyId}</Badge>
                                  )}
                                </div>
                                {item.description && (
                                  <p className="text-sm text-muted-foreground mb-2">{item.description}</p>
                                )}
                                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                  {item.links?.url && (
                                    <a 
                                      href={item.links.url} 
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-1 hover:text-primary"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                      {item.links.domain || new URL(item.links.url).hostname}
                                    </a>
                                  )}
                                  {item.links?.priority && (
                                    <span className="capitalize">Priorita: {item.links.priority}</span>
                                  )}
                                  {item.createdAt && (
                                    <span>Vytvořeno: {new Date(item.createdAt).toLocaleDateString()}</span>
                                  )}
                                </div>
                                {item.links?.tags && item.links.tags.length > 0 && (
                                  <div className="flex gap-1 mt-2">
                                    {item.links.tags.map((tag: string, index: number) => (
                                      <Badge key={index} variant="outline" className="text-xs">
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="homepage" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Konfigurace úvodní stránky</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <Label>Aktivní dlaždice</Label>
                  {homepageTiles.map((tile) => (
                    <div key={tile.id} className="flex items-center justify-between p-3 border border-border rounded-md">
                      <div className="flex items-center gap-3">
                        <Checkbox
                          checked={tile.enabled}
                          onCheckedChange={() => toggleTile(tile.id)}
                        />
                        <div>
                          <div className="font-medium">{tile.title}</div>
                          <div className="text-sm text-muted-foreground">{tile.type}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t border-border pt-4">
                  <Label className="text-base">Přidat novou dlaždici</Label>
                  <div className="flex gap-2 mt-2">
                    <select 
                      value={newTile.type}
                      onChange={(e) => setNewTile({...newTile, type: e.target.value})}
                      className="flex-1 px-3 py-2 border border-input rounded-md bg-background"
                    >
                      <option value="recent-pages">Naposledy aktualizované stránky</option>
                      <option value="recent-cities">Poslední navštívená města</option>
                      <option value="custom-todo">TODO poznámky</option>
                      <option value="progress-stats">Statistiky pokroku</option>
                    </select>
                    <Input
                      placeholder="Vlastní nadpis (volitelný)"
                      value={newTile.title}
                      onChange={(e) => setNewTile({...newTile, title: e.target.value})}
                      className="flex-1"
                    />
                    <Button onClick={addHomepageTile}>Přidat</Button>
                  </div>
                </div>

                <Button onClick={saveHomepageTiles} className="w-full">
                  <Save className="w-4 h-4 mr-2" />
                  Uložit konfiguraci homepage
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="taxonomy" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Správa metadata taxonomie</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Existing items list */}
                <div>
                  <Label>Existující metadata</Label>
                  <div className="space-y-2 mt-2 max-h-40 overflow-y-auto border border-border rounded-md p-2">
                    {taxonomyItems.length === 0 ? (
                      <p className="text-muted-foreground text-sm">Žádná metadata zatím nejsou uložena</p>
                    ) : (
                      taxonomyItems.map((item) => (
                        <div key={item.id} className="flex items-center justify-between p-2 bg-muted/30 rounded-md">
                          <div>
                            <div className="font-medium text-sm">{item.id}</div>
                            <div className="text-xs text-muted-foreground">{item.name}</div>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingItem(item)}
                            >
                              <Edit className="w-3 h-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => deleteTaxonomyItem(item.id)}
                            >
                              <Trash className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Taxonomy selector */}
                <div>
                  <Label>Vybrat položku z taxonomie</Label>
                  <div className="flex gap-2 mt-2">
                    <div className="flex-1">
                      <TaxonomySelect
                        value={selectedTaxonomyId}
                        onChange={setSelectedTaxonomyId}
                        placeholder="Vyberte položku z taxonomie..."
                      />
                    </div>
                    <Button onClick={createNewTaxonomyItem} disabled={!selectedTaxonomyId}>
                      <Plus className="w-4 h-4 mr-2" />
                      Nové metadata
                    </Button>
                  </div>
                </div>

                {/* Edit form */}
                {editingItem && (
                  <Card className="border-2 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-base">
                        {taxonomyItems.find(item => item.id === editingItem.id) ? 'Upravit metadata' : 'Nová metadata'}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="itemId">ID položky</Label>
                          <Input
                            id="itemId"
                            placeholder="02.03.01.05"
                            value={editingItem.id}
                            onChange={(e) => setEditingItem(prev => prev ? {...prev, id: e.target.value} : null)}
                            disabled
                            className="bg-muted"
                          />
                        </div>
                        <div>
                          <Label htmlFor="itemName">Název</Label>
                          <Input
                            id="itemName"
                            placeholder="Název v češtině"
                            value={editingItem.name}
                            onChange={(e) => setEditingItem(prev => prev ? {...prev, name: e.target.value} : null)}
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="itemDescription">Popis</Label>
                        <Textarea
                          id="itemDescription"
                          placeholder="Popis položky"
                          value={editingItem.description}
                          onChange={(e) => setEditingItem(prev => prev ? {...prev, description: e.target.value} : null)}
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="itemIcon">Ikona (emoji nebo lucide název)</Label>
                          <Input
                            id="itemIcon"
                            placeholder="📚 nebo BookOpen"
                            value={editingItem.icon}
                            onChange={(e) => setEditingItem(prev => prev ? {...prev, icon: e.target.value} : null)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="itemLinks">Odkazy (JSON)</Label>
                          <Input
                            id="itemLinks"
                            placeholder='{"wiki": "https://..."}'
                            value={editingItem.links}
                            onChange={(e) => setEditingItem(prev => prev ? {...prev, links: e.target.value} : null)}
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="itemTranslations">Překlady (JSON)</Label>
                        <Textarea
                          id="itemTranslations"
                          placeholder='{"en": "Mathematics", "de": "Mathematik"}'
                          value={editingItem.translations}
                          onChange={(e) => setEditingItem(prev => prev ? {...prev, translations: e.target.value} : null)}
                        />
                      </div>

                      <div className="flex gap-2">
                        <Button 
                          onClick={saveTaxonomyMetadata}
                          disabled={!editingItem.id || !editingItem.name}
                          className="flex-1"
                        >
                          <Save className="w-4 h-4 mr-2" />
                          Uložit metadata
                        </Button>
                        <Button 
                          variant="outline"
                          onClick={() => {
                            setEditingItem(null);
                            setSelectedTaxonomyId(null);
                          }}
                        >
                          Zrušit
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}