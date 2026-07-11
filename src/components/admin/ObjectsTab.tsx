/**
 * Admin tab for knowledge objects — OKF index cards (ROADMAP S1).
 * Create/edit richer-than-notes datapoints: type + title + markdown body,
 * optional resource ref into a live nOS service, tags, and [[node-id]] links
 * in the body that anchor the card into the explorer's nebula layer.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Boxes, Plus, Edit, Trash, Bot, Link2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useNosConfig } from '@/config/nos';
import { objectsApi } from '@/services/api/objects';
import type { KnowledgeObject } from '@/types/database';

const SUGGESTED_TYPES = ['note', 'page', 'query', 'table', 'database', 'file', 'recipe', 'howto', 'contact'];

interface Draft {
  id?: string;
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string;
  body: string;
}

const EMPTY: Draft = { type: '', title: '', description: '', resource: '', tags: '', body: '' };

export default function ObjectsTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const nosConfig = useNosConfig();
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data: objects = [] } = useQuery({
    queryKey: ['objects'],
    queryFn: () => objectsApi.list(),
  });
  const { data: usedTypes = [] } = useQuery({
    queryKey: ['object-types'],
    queryFn: () => objectsApi.types(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['objects'] });
    queryClient.invalidateQueries({ queryKey: ['object-types'] });
    queryClient.invalidateQueries({ queryKey: ['graph'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      objectsApi.save({
        id: d.id,
        type: d.type.trim(),
        title: d.title.trim(),
        description: d.description.trim() || undefined,
        resource: d.resource.trim() || undefined,
        tags: d.tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        body: d.body || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setDraft(null);
      toast({ title: t('common.success'), description: t('admin.objects.saved') });
    },
    onError: () =>
      toast({ title: t('common.error'), description: t('admin.objects.saveFailed'), variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => objectsApi.remove(id),
    onSuccess: () => {
      invalidate();
      toast({ title: t('common.success'), description: t('admin.objects.deleted') });
    },
    onError: () =>
      toast({ title: t('common.error'), description: t('admin.objects.deleteFailed'), variant: 'destructive' }),
  });

  const edit = (o: KnowledgeObject) =>
    setDraft({
      id: o.id,
      type: o.type,
      title: o.title,
      description: o.description ?? '',
      resource: o.resource ?? '',
      tags: (o.tags ?? []).join(', '),
      body: o.body ?? '',
    });

  const typeOptions = [...new Set([...usedTypes, ...SUGGESTED_TYPES])];
  const serviceList = nosConfig.services.map((s) => s.key).join(', ');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Boxes className="w-5 h-5" />
              {t('admin.objects.title')}
            </span>
            {!draft && (
              <Button size="sm" onClick={() => setDraft(EMPTY)}>
                <Plus className="w-4 h-4 mr-1" />
                {t('admin.objects.new')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {draft && (
            <div className="space-y-4 rounded-lg border border-border p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="obj-type">{t('admin.objects.type')}</Label>
                  <Input
                    id="obj-type"
                    list="obj-type-options"
                    value={draft.type}
                    onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                    placeholder={t('admin.objects.typePlaceholder')}
                  />
                  <datalist id="obj-type-options">
                    {typeOptions.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <Label htmlFor="obj-title">{t('admin.objects.name')}</Label>
                  <Input
                    id="obj-title"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="obj-desc">{t('admin.objects.description')}</Label>
                <Input
                  id="obj-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="obj-resource">{t('admin.objects.resource')}</Label>
                  <Input
                    id="obj-resource"
                    value={draft.resource}
                    onChange={(e) => setDraft({ ...draft, resource: e.target.value })}
                    placeholder="kiwix:wikipedia_en/A/…"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('admin.objects.resourceHint', { list: serviceList })}
                  </p>
                </div>
                <div>
                  <Label htmlFor="obj-tags">{t('admin.objects.tags')}</Label>
                  <Input
                    id="obj-tags"
                    value={draft.tags}
                    onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                    placeholder="tag1, tag2"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="obj-body">{t('admin.objects.body')}</Label>
                <Textarea
                  id="obj-body"
                  rows={8}
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  placeholder={t('admin.objects.bodyPlaceholder')}
                />
                <p className="text-xs text-muted-foreground mt-1">{t('admin.objects.bodyHint')}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    if (!draft.type.trim() || !draft.title.trim()) {
                      toast({
                        title: t('common.error'),
                        description: t('admin.objects.typeTitleRequired'),
                        variant: 'destructive',
                      });
                      return;
                    }
                    save.mutate(draft);
                  }}
                  disabled={save.isPending}
                >
                  {t('common.save')}
                </Button>
                <Button variant="outline" onClick={() => setDraft(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {objects.length === 0 && !draft ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>{t('admin.objects.empty')}</p>
              <p className="text-sm mt-1">{t('admin.objects.emptyHint')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {objects.map((o) => (
                <div
                  key={o.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{o.title}</span>
                      <Badge variant="secondary">{o.type}</Badge>
                      {o.resource && (
                        <Badge variant="outline" className="font-mono text-[10px]">
                          <Link2 className="w-3 h-3 mr-1" />
                          {o.resource}
                        </Badge>
                      )}
                      {o.userId?.startsWith('agent:') && (
                        <Badge variant="outline">
                          <Bot className="w-3 h-3 mr-1" />
                          {o.userId.slice(6)}
                        </Badge>
                      )}
                    </div>
                    {o.description && (
                      <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">{o.description}</p>
                    )}
                    {(o.links?.length ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('admin.objects.linkCount', { count: o.links!.length })}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => edit(o)}>
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(o.id)}>
                      <Trash className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
