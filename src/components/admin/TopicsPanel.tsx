/**
 * Admin › Semantic topics (topic_clusters) — the Topics-mode control plane.
 *
 * Embedding-space clusters over knowledge objects, minted + labelled by the
 * server pipeline (server/topics.ts). Identities are birth-frozen; the only
 * admin levers are label overrides (lock/unlock), a per-row θ re-anchor, and
 * Rebuild / Reset-with-confirm. Renders even when the vector layer is
 * unavailable (frozen topics still list; rebuilds disabled). The
 * fs-mappings admin-card precedent — one Card, inline edit, confirm dialog.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Sparkles, RefreshCw, Compass, Edit, Check, X, RotateCcw, Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { topicsApi, type AdminTopic, type TopicRunResult } from '@/services/api/topics';

function timeAgo(sec: number, locale: string): string {
  const s = Math.round(Date.now() / 1000 - sec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export function TopicsPanel() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [resetOpen, setResetOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-topics'],
    queryFn: () => topicsApi.list(),
  });

  const topics = data?.topics ?? [];
  const stats = data?.stats;
  const vectorsReady = stats?.available ?? false;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-topics'] });
    queryClient.invalidateQueries({ queryKey: ['graph'] });
  };
  const fail = (e: Error) =>
    toast({ title: t('common.error'), description: e.message, variant: 'destructive' });

  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string | null }) => topicsApi.rename(id, label),
    onSuccess: (_row, vars) => {
      invalidate();
      setEditId(null);
      toast({
        title: t('common.success'),
        description: vars.label === null ? t('admin.topics.unlocked') : t('admin.topics.renamed'),
      });
    },
    onError: fail,
  });

  const reanchor = useMutation({
    mutationFn: (id: string) => topicsApi.reanchor(id),
    onSuccess: () => {
      invalidate();
      toast({ title: t('common.success'), description: t('admin.topics.reanchorDone') });
    },
    onError: fail,
  });

  const rebuild = useMutation({
    mutationFn: (reset: boolean) => topicsApi.rebuild({ reset, wait: true }),
    onSuccess: (r, reset) => {
      invalidate();
      setResetOpen(false);
      const run = r as TopicRunResult;
      toast({
        title: t('common.success'),
        description: reset
          ? t('admin.topics.resetDone')
          : t('admin.topics.rebuildDone', { k: run.k, n: run.n, moved: run.moved }),
      });
    },
    onError: fail,
  });

  const startEdit = (topic: AdminTopic) => {
    setEditId(topic.id);
    setEditLabel(topic.label);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" />
              {t('admin.topics.title')}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => rebuild.mutate(false)}
                disabled={!vectorsReady || rebuild.isPending}
              >
                <RefreshCw
                  className={`w-4 h-4 mr-1 ${rebuild.isPending && rebuild.variables === false ? 'animate-spin motion-reduce:animate-none' : ''}`}
                />
                {t('admin.topics.rebuild')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setResetOpen(true)}
                disabled={!vectorsReady || rebuild.isPending}
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                {t('admin.topics.reset')}
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('admin.topics.subtitle')}</p>

          {!vectorsReady && (
            <Alert>
              <AlertDescription>{t('admin.topics.unavailable')}</AlertDescription>
            </Alert>
          )}

          {stats && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{t('admin.topics.stats', { k: stats.k, assigned: stats.assigned })}</span>
              <span>
                {stats.lastRunAt
                  ? t('admin.topics.lastRun', { ago: timeAgo(stats.lastRunAt, i18n.language) })
                  : t('admin.topics.neverRun')}
              </span>
            </div>
          )}

          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4">{t('app.connecting')}</p>
          ) : topics.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>{t('admin.topics.empty')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {topics.map((topic) => (
                <div key={topic.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {editId === topic.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && editLabel.trim()) {
                                rename.mutate({ id: topic.id, label: editLabel.trim() });
                              }
                              if (e.key === 'Escape') setEditId(null);
                            }}
                            className="h-8 max-w-xs text-sm"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            disabled={!editLabel.trim() || rename.isPending}
                            onClick={() => rename.mutate({ id: topic.id, label: editLabel.trim() })}
                            aria-label={t('admin.topics.save')}
                          >
                            <Check className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={() => setEditId(null)}
                            aria-label={t('admin.topics.cancel')}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{topic.label}</span>
                          {topic.labelLocked && (
                            <Badge variant="secondary" className="text-[10px]">
                              <Lock className="w-3 h-3 mr-1" />
                              {t('admin.topics.locked')}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px]">
                            {t('admin.topics.members', { count: topic.memberCount })}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">{topic.id}</span>
                        </div>
                      )}
                      {topic.labelLocked && topic.labelAuto && topic.labelAuto !== topic.label && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('admin.topics.autoLabel', { label: topic.labelAuto })}
                        </p>
                      )}
                      {topic.terms.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {topic.terms.slice(0, 8).map((term) => (
                            <Badge key={term} variant="outline" className="text-[10px] font-normal">
                              {term}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => reanchor.mutate(topic.id)}
                        disabled={reanchor.isPending}
                        aria-label={t('admin.topics.reanchor')}
                        title={t('admin.topics.reanchor')}
                      >
                        <Compass className="w-4 h-4" />
                      </Button>
                      {topic.labelLocked ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => rename.mutate({ id: topic.id, label: null })}
                          disabled={rename.isPending}
                          aria-label={t('admin.topics.unlock')}
                          title={t('admin.topics.unlock')}
                        >
                          <Lock className="w-4 h-4" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(topic)}
                          aria-label={t('admin.topics.rename')}
                          title={t('admin.topics.rename')}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.topics.resetTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.topics.resetBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin.topics.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => rebuild.mutate(true)}>
              {t('admin.topics.reset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
