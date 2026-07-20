import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDatabase, type TaxonomyMetadata, type HomepageTile } from '@/hooks/useDatabase';
import { useGraph, type GraphNode } from '@/hooks/useExplorerData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { TaxonomySelect } from '@/components/TaxonomySelect';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Save, Database, Plus, Edit, Trash, Cog, ExternalLink, Bookmark, Bot } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { useNosConfig } from '@/config/nos';
import ObjectsTab from '@/components/admin/ObjectsTab';
import type { ApiTaxonomyMetadata } from '@/types/database';
import { LintPanel } from '@/components/admin/LintPanel';
import { ModerationPanel } from '@/components/admin/ModerationPanel';
import { FsMappingsPanel } from '@/components/admin/FsMappingsPanel';
import { TopicsPanel } from '@/components/admin/TopicsPanel';
import { RelationsPanel } from '@/components/admin/RelationsPanel';

const TILE_TYPES = ['recent-pages', 'recent-cities', 'custom-todo', 'progress-stats', 'explore-map'] as const;

export default function Admin() {
  const { t, i18n } = useTranslation();
  const {
    isInitialized,
    getTaxonomyMetadata,
    saveTaxonomyMetadata: saveTaxonomyMetadataDB,
    deleteTaxonomyMetadata,
    getHomepageTiles,
    saveHomepageTiles: saveHomepageTilesDB,
    getAllMetadataApi,
  } = useDatabase();
  const { toast } = useToast();
  const nosConfig = useNosConfig();

  const [taxonomyItems, setTaxonomyItems] = useState<TaxonomyMetadata[]>([]);
  const [homepageTiles, setHomepageTiles] = useState<HomepageTile[]>([]);
  const [captures, setCaptures] = useState<ApiTaxonomyMetadata[]>([]);
  const [editingItem, setEditingItem] = useState<TaxonomyMetadata | null>(null);
  const [selectedTaxonomyId, setSelectedTaxonomyId] = useState<string | null>(null);
  const [newTile, setNewTile] = useState({ type: 'recent-pages', title: '' });
  const [taxSearch, setTaxSearch] = useState('');

  // The real taxonomy tree (server truth: node names + the K1 curated
  // descriptions). The `taxonomy_metadata` overlay below only carries per-node
  // content-link/icon overrides — rendering the list from THAT alone left roots
  // "unnamed" and the list flat/half-empty. We render the tree, pre-order, and
  // fold the curated overlay in as badges.
  const graph = useGraph();
  const curatedById = useMemo(
    () => new Map(taxonomyItems.map((i) => [i.id, i])),
    [taxonomyItems],
  );
  const orderedNodes = useMemo(() => {
    const nodes = graph.data?.nodes ?? [];
    const byParent = new Map<string | null, GraphNode[]>();
    for (const n of nodes) {
      const key = n.parentId ?? null;
      const bucket = byParent.get(key);
      if (bucket) bucket.push(n);
      else byParent.set(key, [n]);
    }
    const out: GraphNode[] = [];
    const walk = (parentId: string | null) => {
      for (const n of byParent.get(parentId) ?? []) {
        out.push(n);
        walk(n.id);
      }
    };
    walk(null);
    return out;
  }, [graph.data]);
  const visibleNodes = useMemo(() => {
    const q = taxSearch.trim().toLowerCase();
    if (!q) return orderedNodes;
    return orderedNodes.filter(
      (n) =>
        n.id.toLowerCase().includes(q) ||
        n.name.toLowerCase().includes(q) ||
        (n.description ?? '').toLowerCase().includes(q),
    );
  }, [orderedNodes, taxSearch]);

  // Open the curated-metadata editor for a node: reuse an existing overlay row
  // or seed a blank one keyed to the node id (the tree already owns the name).
  const editNode = (node: GraphNode) => {
    setEditingItem(
      curatedById.get(node.id) ?? {
        id: node.id,
        name: node.name,
        description: '',
        icon: '',
        links: '{}',
        translations: '{}',
      },
    );
  };

  const loadData = useCallback(async () => {
    try {
      const taxonomyData = (await getTaxonomyMetadata()) as TaxonomyMetadata[];
      setTaxonomyItems(taxonomyData || []);
      setHomepageTiles((await getHomepageTiles()) || []);
      setCaptures((await getAllMetadataApi()) || []);
    } catch (error) {
      console.error('Error loading data:', error);
      toast({ title: t('common.error'), description: t('admin.taxonomy.loadFailed'), variant: 'destructive' });
    }
  }, [getTaxonomyMetadata, getHomepageTiles, getAllMetadataApi, toast, t]);

  const createNewTaxonomyItem = () => {
    if (!selectedTaxonomyId) {
      toast({ title: t('common.error'), description: t('admin.taxonomy.selectFirst'), variant: 'destructive' });
      return;
    }
    const existingItem = taxonomyItems.find((item) => item.id === selectedTaxonomyId);
    setEditingItem(
      existingItem ?? {
        id: selectedTaxonomyId,
        name: '',
        description: '',
        icon: '',
        links: '{}',
        translations: '{}',
      },
    );
  };

  const saveTaxonomyMetadata = async () => {
    if (!editingItem?.id || !editingItem.name) {
      toast({ title: t('common.error'), description: t('admin.taxonomy.idNameRequired'), variant: 'destructive' });
      return;
    }
    try {
      await saveTaxonomyMetadataDB(editingItem);
      await loadData();
      toast({ title: t('common.success'), description: t('admin.taxonomy.saved') });
      setEditingItem(null);
      setSelectedTaxonomyId(null);
    } catch (error) {
      console.error('Error saving taxonomy metadata:', error);
      toast({ title: t('common.error'), description: t('admin.taxonomy.saveFailed'), variant: 'destructive' });
    }
  };

  const deleteTaxonomyItem = async (id: string) => {
    try {
      await deleteTaxonomyMetadata(id);
      setTaxonomyItems((prev) => prev.filter((item) => item.id !== id));
      toast({ title: t('common.success'), description: t('admin.taxonomy.deleted') });
    } catch (error) {
      console.error('Error deleting taxonomy metadata:', error);
      toast({ title: t('common.error'), description: t('admin.taxonomy.deleteFailed'), variant: 'destructive' });
    }
  };

  const saveHomepageTiles = async () => {
    try {
      await saveHomepageTilesDB(homepageTiles);
      toast({ title: t('common.success'), description: t('admin.homepage.saved') });
    } catch (error) {
      console.error('Error saving homepage tiles:', error);
      toast({ title: t('common.error'), description: t('admin.homepage.saveFailed'), variant: 'destructive' });
    }
  };

  const addHomepageTile = () => {
    const tile: HomepageTile = {
      id: crypto.randomUUID(),
      type: newTile.type as HomepageTile['type'],
      title: newTile.title || t(`admin.tileTypes.${newTile.type}`),
      visible: true,
      position: homepageTiles.length,
      config: '{}',
    };
    setHomepageTiles([...homepageTiles, tile]);
    setNewTile({ type: 'recent-pages', title: '' });
  };

  const toggleTile = (id: string) => {
    setHomepageTiles((prev) =>
      prev.map((tile) => (tile.id === id ? { ...tile, visible: !tile.visible } : tile)),
    );
  };

  useEffect(() => {
    if (isInitialized) loadData();
  }, [isInitialized, loadData]);

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Database className="w-8 h-8 mx-auto mb-2 text-muted-foreground animate-pulse motion-reduce:animate-none" />
          <p className="text-muted-foreground">{t('app.connecting')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 text-foreground hover:text-primary">
              <ArrowLeft className="w-4 h-4" />
              {t('admin.backHome')}
            </Link>
            <h1 className="text-lg font-semibold tracking-tight">{t('admin.title')}</h1>
          </div>
          <Link to="/settings">
            <Button variant="ghost" size="sm" className="flex items-center gap-2">
              <Cog className="w-4 h-4" />
              {t('admin.settings')}
            </Button>
          </Link>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6">
        <Tabs defaultValue="captures" className="space-y-6">
          <TabsList className="w-full max-w-2xl">
            <TabsTrigger value="captures" className="flex-1">{t('admin.tabs.captures')}</TabsTrigger>
            <TabsTrigger value="objects" className="flex-1">{t('admin.tabs.objects')}</TabsTrigger>
            <TabsTrigger value="homepage" className="flex-1">{t('admin.tabs.homepage')}</TabsTrigger>
            <TabsTrigger value="taxonomy" className="flex-1">{t('admin.tabs.taxonomy')}</TabsTrigger>
            <TabsTrigger value="lint" className="flex-1">{t('admin.tabs.lint')}</TabsTrigger>
            <TabsTrigger value="moderation" className="flex-1">{t('admin.tabs.moderation')}</TabsTrigger>
            <TabsTrigger value="relations" className="flex-1">{t('admin.tabs.relations')}</TabsTrigger>
            <TabsTrigger value="fs" className="flex-1">{t('admin.tabs.fsMappings')}</TabsTrigger>
            <TabsTrigger value="topics" className="flex-1">{t('admin.tabs.topics')}</TabsTrigger>
          </TabsList>

          <TabsContent value="fs" className="space-y-6">
            <FsMappingsPanel />
          </TabsContent>

          <TabsContent value="topics" className="space-y-6">
            <TopicsPanel />
          </TabsContent>

          <TabsContent value="moderation" className="space-y-6">
            <ModerationPanel />
          </TabsContent>

          <TabsContent value="relations" className="space-y-6">
            <RelationsPanel />
          </TabsContent>

          <TabsContent value="lint" className="space-y-6">
            <LintPanel />
          </TabsContent>

          <TabsContent value="objects">
            <ObjectsTab />
          </TabsContent>

          <TabsContent value="captures" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bookmark className="w-5 h-5" />
                  {t('admin.captures.title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {captures.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Database className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>{t('admin.captures.empty')}</p>
                    <p className="text-sm">{t('admin.captures.emptyHint')}</p>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {captures.map((item) => {
                      const links = item.metadata?.links;
                      const taxonomyId = item.metadata?.taxonomyId;
                      const fromAgent = item.userId?.startsWith('agent:');
                      return (
                        <Card key={item.id} className="border-l-4 border-l-primary">
                          <CardContent className="p-4">
                            <div className="flex items-center gap-2 mb-2">
                              {item.metadata?.icon && <span className="text-lg">{item.metadata.icon}</span>}
                              <h3 className="font-semibold">{item.title}</h3>
                              {taxonomyId && <Badge variant="secondary">{taxonomyId}</Badge>}
                              {fromAgent && (
                                <Badge variant="outline" className="flex items-center gap-1">
                                  <Bot className="w-3 h-3" />
                                  {item.userId?.slice('agent:'.length)}
                                </Badge>
                              )}
                            </div>
                            {item.description && (
                              <p className="text-sm text-muted-foreground mb-2">{item.description}</p>
                            )}
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              {item.url && (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 hover:text-primary"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  {item.domain ?? item.url}
                                </a>
                              )}
                              {links?.priority && (
                                <span className="capitalize">
                                  {t('admin.captures.priority', { value: links.priority })}
                                </span>
                              )}
                              {item.createdAt && (
                                <span>
                                  {t('admin.captures.created', {
                                    date: new Date(item.createdAt * 1000).toLocaleDateString(i18n.language),
                                  })}
                                </span>
                              )}
                            </div>
                            {links?.tags?.length > 0 && (
                              <div className="flex gap-1 mt-2">
                                {links.tags.map((tag: string) => (
                                  <Badge key={tag} variant="outline" className="text-xs">
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="homepage" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('admin.homepage.title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <Label>{t('admin.homepage.activeTiles')}</Label>
                  {homepageTiles.map((tile) => (
                    <div
                      key={tile.id}
                      className="flex items-center justify-between p-3 border border-border rounded-md"
                    >
                      <div className="flex items-center gap-3">
                        <Checkbox checked={tile.visible} onCheckedChange={() => toggleTile(tile.id)} />
                        <div>
                          <div className="font-medium">{tile.title}</div>
                          <div className="text-sm text-muted-foreground">
                            {t(`admin.tileTypes.${tile.type}`, { defaultValue: tile.type })}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t border-border pt-4">
                  <Label className="text-base">{t('admin.homepage.addTile')}</Label>
                  <div className="flex gap-2 mt-2">
                    <select
                      value={newTile.type}
                      onChange={(e) => setNewTile({ ...newTile, type: e.target.value })}
                      className="flex-1 px-3 py-2 border border-input rounded-md bg-background"
                    >
                      {TILE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`admin.tileTypes.${type}`)}
                        </option>
                      ))}
                    </select>
                    <Input
                      placeholder={t('admin.homepage.customTitle')}
                      value={newTile.title}
                      onChange={(e) => setNewTile({ ...newTile, title: e.target.value })}
                      className="flex-1"
                    />
                    <Button onClick={addHomepageTile}>{t('common.add')}</Button>
                  </div>
                </div>

                <Button onClick={saveHomepageTiles} className="w-full">
                  <Save className="w-4 h-4 mr-2" />
                  {t('admin.homepage.saveConfig')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="taxonomy" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('admin.taxonomy.title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <Label>{t('admin.taxonomy.existing')}</Label>
                    <span className="text-xs text-muted-foreground">
                      {t('admin.taxonomy.nodeCount', { count: orderedNodes.length })}
                    </span>
                  </div>
                  <Input
                    className="mt-2"
                    placeholder={t('admin.taxonomy.searchPlaceholder')}
                    value={taxSearch}
                    onChange={(e) => setTaxSearch(e.target.value)}
                  />
                  <div className="space-y-0.5 mt-2 max-h-[32rem] overflow-y-auto border border-border rounded-md p-2">
                    {graph.isLoading ? (
                      <p className="text-muted-foreground text-sm p-2">{t('app.connecting')}</p>
                    ) : visibleNodes.length === 0 ? (
                      <p className="text-muted-foreground text-sm p-2">{t('admin.taxonomy.empty')}</p>
                    ) : (
                      visibleNodes.map((node) => {
                        const curated = curatedById.get(node.id);
                        const desc = node.description || curated?.description;
                        return (
                          <div
                            key={node.id}
                            className="flex items-start justify-between gap-2 py-1.5 pr-2 rounded-md hover:bg-muted/40"
                            style={{ paddingLeft: `${node.level * 16 + 8}px` }}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                {node.level > 0 && (
                                  <span className="text-muted-foreground select-none">└</span>
                                )}
                                <span
                                  className={
                                    node.level === 0 ? 'font-semibold' : 'font-medium text-sm'
                                  }
                                >
                                  {node.name}
                                </span>
                                <Badge variant="outline" className="text-[10px] font-mono font-normal">
                                  {node.id}
                                </Badge>
                                {node.dataType && (
                                  <Badge variant="secondary" className="text-[10px] font-normal">
                                    {node.dataType}
                                  </Badge>
                                )}
                                {curated?.requiredData && (
                                  <Badge variant="outline" className="text-[10px] font-normal">
                                    {curated.requiredData}
                                  </Badge>
                                )}
                                {curated && (
                                  <Badge variant="secondary" className="text-[10px] font-normal">
                                    {t('admin.taxonomy.curatedBadge')}
                                  </Badge>
                                )}
                              </div>
                              {desc && (
                                <p className="text-xs text-muted-foreground line-clamp-2">{desc}</p>
                              )}
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => editNode(node)}
                                aria-label={t('common.edit')}
                              >
                                <Edit className="w-3 h-3" />
                              </Button>
                              {curated && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => deleteTaxonomyItem(node.id)}
                                  aria-label={t('common.delete')}
                                >
                                  <Trash className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div>
                  <Label>{t('admin.taxonomy.pickItem')}</Label>
                  <div className="flex gap-2 mt-2">
                    <div className="flex-1">
                      <TaxonomySelect
                        value={selectedTaxonomyId}
                        onChange={setSelectedTaxonomyId}
                        placeholder={t('admin.taxonomy.pickPlaceholder')}
                      />
                    </div>
                    <Button onClick={createNewTaxonomyItem} disabled={!selectedTaxonomyId}>
                      <Plus className="w-4 h-4 mr-2" />
                      {t('admin.taxonomy.newMetadata')}
                    </Button>
                  </div>
                </div>

                {editingItem && (
                  <Card className="border-2 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-base">
                        {taxonomyItems.some((item) => item.id === editingItem.id)
                          ? t('admin.taxonomy.editMetadata')
                          : t('admin.taxonomy.newMetadata')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="itemId">{t('admin.taxonomy.itemId')}</Label>
                          <Input id="itemId" value={editingItem.id} disabled className="bg-muted" />
                        </div>
                        <div>
                          <Label htmlFor="itemName">{t('admin.taxonomy.name')}</Label>
                          <Input
                            id="itemName"
                            placeholder={t('admin.taxonomy.namePlaceholder')}
                            value={editingItem.name}
                            onChange={(e) =>
                              setEditingItem((prev) => (prev ? { ...prev, name: e.target.value } : null))
                            }
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="itemDescription">{t('admin.taxonomy.description')}</Label>
                        <Textarea
                          id="itemDescription"
                          placeholder={t('admin.taxonomy.descriptionPlaceholder')}
                          value={editingItem.description}
                          onChange={(e) =>
                            setEditingItem((prev) => (prev ? { ...prev, description: e.target.value } : null))
                          }
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="itemIcon">{t('admin.taxonomy.icon')}</Label>
                          <Input
                            id="itemIcon"
                            placeholder="📚 / BookOpen"
                            value={editingItem.icon}
                            onChange={(e) =>
                              setEditingItem((prev) => (prev ? { ...prev, icon: e.target.value } : null))
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor="itemLinks">{t('admin.taxonomy.links')}</Label>
                          <Input
                            id="itemLinks"
                            placeholder='{"kiwix": "kiwix:wikipedia_en"}'
                            value={editingItem.links}
                            onChange={(e) =>
                              setEditingItem((prev) => (prev ? { ...prev, links: e.target.value } : null))
                            }
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="itemRequiredData">{t('admin.taxonomy.requiredData')}</Label>
                        <Input
                          id="itemRequiredData"
                          placeholder="kiwix:wikipedia_en"
                          list="nos-service-keys"
                          value={editingItem.requiredData ?? ''}
                          onChange={(e) =>
                            setEditingItem((prev) =>
                              prev ? { ...prev, requiredData: e.target.value || undefined } : null,
                            )
                          }
                        />
                        <datalist id="nos-service-keys">
                          {nosConfig.services.map((s) => (
                            <option key={s.key} value={`${s.key}:`} label={`${s.label} · ${s.type}`} />
                          ))}
                        </datalist>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('admin.taxonomy.requiredDataHint', {
                            list: nosConfig.services.map((s) => s.key).join(', '),
                          })}
                        </p>
                      </div>

                      <div>
                        <Label htmlFor="itemTranslations">{t('admin.taxonomy.translations')}</Label>
                        <Textarea
                          id="itemTranslations"
                          placeholder='{"en": "Mathematics", "cs": "Matematika"}'
                          value={editingItem.translations}
                          onChange={(e) =>
                            setEditingItem((prev) => (prev ? { ...prev, translations: e.target.value } : null))
                          }
                        />
                      </div>

                      <div className="flex gap-2">
                        <Button
                          onClick={saveTaxonomyMetadata}
                          disabled={!editingItem.id || !editingItem.name}
                          className="flex-1"
                        >
                          <Save className="w-4 h-4 mr-2" />
                          {t('admin.taxonomy.saveMetadata')}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setEditingItem(null);
                            setSelectedTaxonomyId(null);
                          }}
                        >
                          {t('common.cancel')}
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
