import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Database, Info, Globe, Palette, RotateCcw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useDatabase } from '@/hooks/useDatabase';
import { useTheme } from '@/hooks/useTheme';

export default function Settings() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isInitialized, getSetting, saveSetting, getAppMetadata } = useDatabase();
  const { isDark, setTheme } = useTheme();
  const [language, setLanguage] = useState('cs');
  const [appMetadata, setAppMetadata] = useState<any>(null);

  useEffect(() => {
    if (!isInitialized) return;

    // Load settings from database
    const savedLanguage = getSetting('language') || 'cs';
    setLanguage(savedLanguage);
    
    // Load app metadata
    const metadata = getAppMetadata();
    setAppMetadata(metadata);
  }, [isInitialized, getSetting, getAppMetadata]);

  const handleLanguageChange = (newLanguage: string) => {
    setLanguage(newLanguage);
    saveSetting('language', newLanguage);
    localStorage.setItem('app-language', newLanguage);
    toast({
      title: "Jazyk změněn",
      description: `Jazyk aplikace byl změněn na ${newLanguage === 'cs' ? 'češtinu' : 'angličtinu'}`
    });
  };

  const handleThemeChange = (isDark: boolean) => {
    setTheme(isDark ? 'dark' : 'light');
    toast({
      title: "Téma změněno",
      description: `Aplikace přepnuta do ${isDark ? 'tmavého' : 'světlého'} režimu`
    });
  };

  const resetDatabase = () => {
    if (confirm('Opravdu chcete resetovat databázi? Všechna data budou ztracena a aplikace bude restartována.')) {
      localStorage.removeItem('iiab-database');
      toast({
        title: "Databáze resetována",
        description: "Aplikace bude restartována"
      });
      
      setTimeout(() => {
        window.location.href = '/setup';
      }, 1000);
    }
  };

  const exportData = () => {
    try {
      const data = localStorage.getItem('iiab-database');
      if (data) {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `iiab-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        
        toast({
          title: "Export dokončen",
          description: "Data byla exportována do souboru"
        });
      }
    } catch (error) {
      toast({
        title: "Chyba exportu",
        description: "Nepodařilo se exportovat data",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-14 flex items-center gap-4">
          <Button 
            variant="ghost" 
            size="sm"
            onClick={() => navigate('/admin')}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Zpět do administrace
          </Button>
          <h1 className="text-lg font-semibold">Nastavení</h1>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="general" className="flex items-center gap-2">
              <Palette className="w-4 h-4" />
              Obecné
            </TabsTrigger>
            <TabsTrigger value="database" className="flex items-center gap-2">
              <Database className="w-4 h-4" />
              Databáze
            </TabsTrigger>
            <TabsTrigger value="about" className="flex items-center gap-2">
              <Info className="w-4 h-4" />
              O aplikaci
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="w-5 h-5" />
                  Jazyk a vzhled
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="language">Jazyk aplikace</Label>
                  <Select value={language} onValueChange={handleLanguageChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cs">Čeština</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="dark-mode">Tmavý režim</Label>
                    <p className="text-sm text-muted-foreground">
                      Přepnout mezi světlým a tmavým tématem
                    </p>
                  </div>
                  <Switch
                    id="dark-mode"
                    checked={isDark}
                    onCheckedChange={handleThemeChange}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="database" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5" />
                  Správa databáze
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <div>
                    <h4 className="font-medium">Export dat</h4>
                    <p className="text-sm text-muted-foreground mb-3">
                      Exportujte všechna data do záložního souboru
                    </p>
                    <Button onClick={exportData} variant="outline">
                      <Database className="w-4 h-4 mr-2" />
                      Exportovat data
                    </Button>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="font-medium">Informace o databázi</h4>
                    <p className="text-sm text-muted-foreground mb-3">
                      Technické informace o stavu aplikace
                    </p>
                    {appMetadata && (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Vlastnost</TableHead>
                            <TableHead>Hodnota</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow>
                            <TableCell className="font-medium">Verze aplikace</TableCell>
                            <TableCell>{appMetadata.version}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Poslední aktualizace</TableCell>
                            <TableCell>{new Date(appMetadata.lastUpdate).toLocaleString('cs-CZ')}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Provedené migrace</TableCell>
                            <TableCell>{JSON.parse(appMetadata.migrations).length}</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    )}
                  </div>

                  <Separator />

                  <div>
                    <h4 className="font-medium text-destructive">Nebezpečná zóna</h4>
                    <p className="text-sm text-muted-foreground mb-3">
                      Resetování databáze smaže všechna uložená data
                    </p>
                    <Button onClick={resetDatabase} variant="destructive">
                      <RotateCcw className="w-4 h-4 mr-2" />
                      Resetovat databázi
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="about" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Info className="w-5 h-5" />
                  Informace o aplikaci
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium">Verze</Label>
                    <p className="text-sm text-muted-foreground">1.0.0</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Databáze</Label>
                    <p className="text-sm text-muted-foreground">SQLite (SQL.js)</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Framework</Label>
                    <p className="text-sm text-muted-foreground">React + TypeScript</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">UI knihovna</Label>
                    <p className="text-sm text-muted-foreground">Shadcn/ui + Tailwind CSS</p>
                  </div>
                </div>

                <Separator />

                <div>
                  <Label className="text-sm font-medium">Popis</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Minimalistická educational aplikace s gamifikovaným rozhraním 
                    pro procházení hierarchické taxonomie znalostí. Obsahuje CMS pro 
                    správu metadat, konfiguraci homepage a sledování pokroku uživatele.
                  </p>
                </div>

                <div>
                  <Label className="text-sm font-medium">Funkce</Label>
                  <ul className="text-sm text-muted-foreground mt-1 space-y-1">
                    <li>• Gamifikované procházení taxonomie</li>
                    <li>• Administrace metadat a překladů</li>
                    <li>• Konfigurovatelná homepage s dlaždicemi</li>
                    <li>• Sledování pokroku a aktivity</li>
                    <li>• Offline databáze v prohlížeči</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}