import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Database, Info, Globe, Palette, Download } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useDatabase } from '@/hooks/useDatabase';
import { useTheme } from '@/hooks/useTheme';
import { todosApi } from '@/services/api/todos';
import { completionApi } from '@/services/api/completion';
import { metadataApi } from '@/services/api/metadata';

export default function Settings() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { isInitialized, saveSetting, getAppMetadata } = useDatabase();
  const { isDark, setTheme } = useTheme();
  const [appMetadata, setAppMetadata] = useState<any>(null);

  useEffect(() => {
    if (!isInitialized) return;
    getAppMetadata()
      .then(setAppMetadata)
      .catch((error) => console.error('Error loading metadata:', error));
  }, [isInitialized, getAppMetadata]);

  const handleLanguageChange = async (newLanguage: string) => {
    // i18next persists to localStorage ('app-language'); the DB setting keeps
    // the preference attached to the SSO user across browsers.
    await i18n.changeLanguage(newLanguage);
    saveSetting('language', newLanguage).catch(() => {});
    toast({
      title: t('settings.languageChanged'),
      description: t('settings.languageChangedTo', {
        language: newLanguage === 'cs' ? t('settings.czech') : t('settings.english'),
      }),
    });
  };

  const handleThemeChange = (dark: boolean) => {
    setTheme(dark ? 'dark' : 'light');
    toast({
      title: t('settings.themeChanged'),
      description: t('settings.themeChangedTo', { mode: dark ? t('settings.dark') : t('settings.light') }),
    });
  };

  // Real export: aggregate the signed-in user's data from the API (the old
  // implementation exported a localStorage key that was never written).
  const exportData = async () => {
    try {
      const [todos, completedItems, captures] = await Promise.all([
        todosApi.getTodos(),
        completionApi.getCompletedItems(),
        metadataApi.getAllMetadata(),
      ]);
      const payload = {
        exportedAt: new Date().toISOString(),
        todos,
        completedItems,
        captures,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `keap-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: t('settings.exportDone'), description: t('settings.exportDoneHint') });
    } catch (error) {
      console.error('Export failed:', error);
      toast({
        title: t('settings.exportFailed'),
        description: t('settings.exportFailedHint'),
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-14 flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/admin')}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('settings.backToAdmin')}
          </Button>
          <h1 className="text-lg font-semibold tracking-tight">{t('settings.title')}</h1>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="general" className="flex items-center gap-2">
              <Palette className="w-4 h-4" />
              {t('settings.tabs.general')}
            </TabsTrigger>
            <TabsTrigger value="data" className="flex items-center gap-2">
              <Database className="w-4 h-4" />
              {t('settings.tabs.data')}
            </TabsTrigger>
            <TabsTrigger value="about" className="flex items-center gap-2">
              <Info className="w-4 h-4" />
              {t('settings.tabs.about')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="w-5 h-5" />
                  {t('settings.languageAppearance')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="language">{t('settings.language')}</Label>
                  <Select value={i18n.resolvedLanguage} onValueChange={handleLanguageChange}>
                    <SelectTrigger id="language">
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
                    <Label htmlFor="dark-mode">{t('settings.darkMode')}</Label>
                    <p className="text-sm text-muted-foreground">{t('settings.darkModeHint')}</p>
                  </div>
                  <Switch id="dark-mode" checked={isDark} onCheckedChange={handleThemeChange} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="data" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5" />
                  {t('settings.dataManagement')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="font-medium">{t('settings.export')}</h4>
                  <p className="text-sm text-muted-foreground mb-3">{t('settings.exportHint')}</p>
                  <Button onClick={exportData} variant="outline">
                    <Download className="w-4 h-4 mr-2" />
                    {t('settings.exportButton')}
                  </Button>
                </div>

                <Separator />

                <div>
                  <h4 className="font-medium">{t('settings.dbInfo')}</h4>
                  <p className="text-sm text-muted-foreground mb-3">{t('settings.dbInfoHint')}</p>
                  {appMetadata && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('settings.property')}</TableHead>
                          <TableHead>{t('settings.value')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">{t('settings.appVersion')}</TableCell>
                          <TableCell>{appMetadata.version}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">{t('settings.lastUpdated')}</TableCell>
                          <TableCell>
                            {new Date(appMetadata.lastUpdated * 1000).toLocaleString(i18n.language)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="about" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Info className="w-5 h-5" />
                  {t('settings.about')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium">{t('settings.aboutVersion')}</Label>
                    <p className="text-sm text-muted-foreground">{appMetadata?.version ?? '1.0.0'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">{t('settings.aboutDatabase')}</Label>
                    <p className="text-sm text-muted-foreground">SQLite (better-sqlite3)</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">{t('settings.aboutFramework')}</Label>
                    <p className="text-sm text-muted-foreground">React + TypeScript + Express</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">{t('settings.aboutUi')}</Label>
                    <p className="text-sm text-muted-foreground">shadcn/ui + Tailwind CSS</p>
                  </div>
                </div>

                <Separator />

                <div>
                  <Label className="text-sm font-medium">{t('settings.aboutDescription')}</Label>
                  <p className="text-sm text-muted-foreground mt-1">{t('settings.aboutDescriptionText')}</p>
                </div>

                <div>
                  <Label className="text-sm font-medium">{t('settings.aboutFeatures')}</Label>
                  <ul className="text-sm text-muted-foreground mt-1 space-y-1">
                    {(t('settings.aboutFeaturesList', { returnObjects: true }) as string[]).map((f) => (
                      <li key={f}>• {f}</li>
                    ))}
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
