/**
 * Docked detail panel for the selected point — the drawer's replacement.
 * Non-modal by design: it floats over the canvas' left edge so the universe
 * stays interactive while the panel is open (the old bottom sheet's backdrop
 * blocked everything and offered no actions).
 *
 * For a taxonomy node it is the node's COCKPIT: ancestry breadcrumb, zone +
 * provenance badges, the curated description (K1, locale-aware), children,
 * anchored knowledge objects, the resolved content link — and the Track T
 * growth actions: propose a child node and propose a description, both
 * through the same moderated machinery agents use.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Crosshair,
  X,
  Sparkles,
  GitBranchPlus,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiFetch } from '@/services/api/client';
import type { GraphNode, GraphObject } from '@/hooks/useExplorerData';

export interface DrawerTarget {
  id: string;
  name: string;
  kind: string;
  dataType?: string;
  description?: string;
  url?: string;
  distance?: number;
  isStar: boolean;
  nodeId?: string;
}

interface Props {
  target: DrawerTarget | null;
  nodeById: Map<string, GraphNode>;
  objects: GraphObject[];
  onClose: () => void;
  onFocus: (nodeId: string) => void;
  onSelect: (id: string) => void;
}

function ancestors(id: string, nodeById: Map<string, GraphNode>): GraphNode[] {
  const out: GraphNode[] = [];
  let cur = nodeById.get(id);
  while (cur?.parentId) {
    cur = nodeById.get(cur.parentId);
    if (cur) out.unshift(cur);
  }
  return out;
}

const zoneVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  anchor: 'default',
  votable: 'secondary',
  free: 'outline',
};

export default function DetailPanel({ target, nodeById, objects, onClose, onFocus, onSelect }: Props) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [growOpen, setGrowOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [childName, setChildName] = useState('');
  const [childDesc, setChildDesc] = useState('');
  const [descEn, setDescEn] = useState('');
  const [descCs, setDescCs] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const node = target && !target.isStar ? nodeById.get(target.id) : null;
  const crumb = useMemo(() => (node ? ancestors(node.id, nodeById) : []), [node, nodeById]);
  const children = useMemo(() => {
    if (!node) return [];
    return [...nodeById.values()]
      .filter((n) => n.parentId === node.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [node, nodeById]);
  const anchored = useMemo(
    () => (node ? objects.filter((o) => o.anchors.includes(node.id)) : []),
    [node, objects],
  );

  const growMut = useMutation({
    mutationFn: () =>
      apiFetch<{ status: string; nodeId?: string }>('/api/taxonomy/propose', {
        method: 'POST',
        body: JSON.stringify({ parentId: node!.id, name: childName, description: childDesc }),
      }),
    onSuccess: (r) => {
      setChildName('');
      setChildDesc('');
      setGrowOpen(false);
      if (r.status === 'approved') {
        // Free zone materializes instantly — the new star appears NOW.
        qc.invalidateQueries({ queryKey: ['graph'] });
        setNotice(t('explore.detail.growApproved', { id: r.nodeId }));
      } else {
        setNotice(t('explore.detail.growProposed'));
      }
    },
    onError: (e: Error) => setNotice(e.message),
  });

  const descMut = useMutation({
    mutationFn: () =>
      apiFetch('/api/taxonomy/describe', {
        method: 'POST',
        body: JSON.stringify({ nodeId: node!.id, descriptionEn: descEn, descriptionCs: descCs || undefined }),
      }),
    onSuccess: () => {
      setDescEn('');
      setDescCs('');
      setDescOpen(false);
      setNotice(t('explore.detail.descProposed'));
    },
    onError: (e: Error) => setNotice(e.message),
  });

  if (!target) return null;

  const description = node
    ? (i18n.language?.startsWith('cs') && node.descriptionCs) || node.description
    : target.description;
  const zone = node?.zone;

  return (
    <div className="absolute bottom-3 left-3 top-3 z-10 flex w-[330px] flex-col rounded-lg border border-white/10 bg-background/85 shadow-xl backdrop-blur">
      <div className="flex items-start gap-2 border-b border-white/10 p-3">
        <div className="min-w-0 flex-1">
          {node && crumb.length > 0 && (
            <nav className="mb-1 flex flex-wrap items-center gap-0.5 text-[11px] text-muted-foreground">
              {crumb.map((a) => (
                <span key={a.id} className="flex items-center gap-0.5">
                  <button className="hover:text-foreground hover:underline" onClick={() => onSelect(a.id)}>
                    {a.name}
                  </button>
                  <ChevronRight className="h-3 w-3 opacity-50" />
                </span>
              ))}
            </nav>
          )}
          <h2 className="text-sm font-semibold leading-tight">
            {target.isStar ? '☆ ' : ''}
            {target.name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {zone && (
              <Badge variant={zoneVariant[zone]} className="text-[10px]">
                {t(`explore.detail.zone.${zone}`)}
              </Badge>
            )}
            {node?.ext && <Badge variant="outline" className="text-[10px]">{t('explore.detail.grown')}</Badge>}
            {target.dataType && <Badge variant="secondary" className="text-[10px]">{target.dataType}</Badge>}
            {target.distance !== undefined && (
              <span className="text-[11px] tabular-nums text-muted-foreground">d = {target.distance.toFixed(3)}</span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose} aria-label={t('common.close')}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : (
            !target.isStar && <p className="text-xs italic text-muted-foreground/70">{t('explore.detail.noDescription')}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {(target.url ?? node?.url) && (
              <Button asChild size="sm" className="h-7 text-xs">
                <a href={target.url ?? node?.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1 h-3 w-3" />
                  {t('explore.drawer.open')}
                </a>
              </Button>
            )}
            {target.isStar && target.nodeId && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onFocus(target.nodeId!)}>
                <Crosshair className="mr-1 h-3 w-3" />
                {t('explore.drawer.focus')}
              </Button>
            )}
            {node && (
              <>
                <Button
                  size="sm"
                  variant={descOpen ? 'secondary' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => { setDescOpen((v) => !v); setGrowOpen(false); setNotice(null); }}
                >
                  <Sparkles className="mr-1 h-3 w-3" />
                  {t('explore.detail.describe')}
                </Button>
                <Button
                  size="sm"
                  variant={growOpen ? 'secondary' : 'outline'}
                  className="h-7 text-xs"
                  disabled={zone === 'anchor'}
                  title={zone === 'anchor' ? t('explore.detail.anchorLocked') : undefined}
                  onClick={() => { setGrowOpen((v) => !v); setDescOpen(false); setNotice(null); }}
                >
                  <GitBranchPlus className="mr-1 h-3 w-3" />
                  {t('explore.detail.grow')}
                </Button>
              </>
            )}
          </div>

          {notice && <p className="rounded bg-muted/60 p-2 text-[11px] text-muted-foreground">{notice}</p>}

          {node && growOpen && (
            <div className="space-y-2 rounded-md border border-white/10 p-2">
              <p className="text-[11px] text-muted-foreground">
                {zone === 'free' ? t('explore.detail.growHintFree') : t('explore.detail.growHintVotable')}
              </p>
              <Input
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                placeholder={t('explore.detail.childName')}
                className="h-7 text-xs"
              />
              <Textarea
                value={childDesc}
                onChange={(e) => setChildDesc(e.target.value)}
                placeholder={t('explore.detail.childDesc')}
                className="min-h-16 text-xs"
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={growMut.isPending || !childName.trim() || childDesc.trim().length < 20}
                onClick={() => growMut.mutate()}
              >
                {growMut.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {t('explore.detail.submitGrow')}
              </Button>
            </div>
          )}

          {node && descOpen && (
            <div className="space-y-2 rounded-md border border-white/10 p-2">
              <p className="text-[11px] text-muted-foreground">{t('explore.detail.descHint')}</p>
              <Textarea
                value={descEn}
                onChange={(e) => setDescEn(e.target.value)}
                placeholder={t('explore.detail.descEn')}
                className="min-h-16 text-xs"
              />
              <Textarea
                value={descCs}
                onChange={(e) => setDescCs(e.target.value)}
                placeholder={t('explore.detail.descCs')}
                className="min-h-16 text-xs"
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={descMut.isPending || descEn.trim().length < 20}
                onClick={() => descMut.mutate()}
              >
                {descMut.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {t('explore.detail.submitDesc')}
              </Button>
            </div>
          )}

          {children.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('explore.detail.children', { count: children.length })}
              </p>
              <ul className="space-y-0.5">
                {children.map((c) => (
                  <li key={c.id}>
                    <button
                      className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                      onClick={() => onSelect(c.id)}
                    >
                      <span className="truncate">{c.name}</span>
                      {c.childCount > 0 && (
                        <span className="ml-2 shrink-0 tabular-nums text-[10px] text-muted-foreground">{c.childCount}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {anchored.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('explore.detail.anchored', { count: anchored.length })}
              </p>
              <ul className="space-y-0.5">
                {anchored.map((o) => (
                  <li key={o.id}>
                    <button
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                      onClick={() => onSelect(`obj:${o.id}`)}
                    >
                      <Badge variant="outline" className="shrink-0 px-1 text-[9px]">{o.type}</Badge>
                      <span className="truncate">{o.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
