/**
 * Admin › Mapped folders (fs_mappings) — admin-managed read-only mirrors of
 * KEAP_FS_ROOTS directories into knowledge objects.
 *
 * Status strip (mounted roots + the per-user tree line), one card per
 * mapping with live sync status, and an inline create/edit form: folder
 * picker (FolderBrowser), object template (type + frontmatter), tags,
 * taxonomy anchors (root + links, rendered as hub rays in Explore) and the
 * shared/private visibility flag. Roots themselves are mounted by nOS
 * (keap_fs_roots) — with none mounted the panel degrades to a callout.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
import { TaxonomySelect } from '@/components/TaxonomySelect';
import { FolderBrowser } from '@/components/admin/FolderBrowser';
import { FolderSymlink, Plus, Edit, Trash, RefreshCw, X, TriangleAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useGraph } from '@/hooks/useExplorerData';
import { objectsApi } from '@/services/api/objects';
import {
  fsMappingsApi,
  type FsMapping,
  type FsMappingDraft,
  type FsMappingSyncResult,
} from '@/services/api/fsMappings';

/** Canonical asset types (server/asset-types.ts AssetType) — merged into the
 *  type datalist next to the types already in use. */
const CANONICAL_ASSET_TYPES = [
  'database', 'dataTable', 'query', 'repo', 'fileshare', 'file',
  'encyclopedia', 'books', 'wiki', 'notes', 'page', 'blog',
  'media', 'video', 'audio', 'image', 'ai', 'maps', 'rss', 'capture', 'generic',
];

/** The sync engine owns these frontmatter keys — the server strips them from
 *  the template; flagging here is honest feedback, not enforcement. */
const RESERVED_FM_KEYS = ['source', 'mapping', 'root', 'path', 'size', 'mtime', 'cfg'];

const MAX_TAXONOMY_LINKS = 12;

interface Draft {
  id?: string;
  rootKey: string;
  /** null until the admin commits a folder via "Use this folder" (create). */
  relPath: string | null;
  /** Coverage reported by the picker at commit time — blocks Save when it is
   *  another mapping (the server would 409 anyway). */
  pathMappedBy: string | null;
  label: string;
  description: string;
  nestUnderFiles: boolean;
  schemaType: string;
  frontmatterText: string;
  tags: string[];
  taxonomyRoot: string | null;
  taxonomyLinks: string[];
  visibility: 'shared' | 'private';
  enabled: boolean;
}

const emptyDraft = (rootKey: string): Draft => ({
  rootKey,
  relPath: null,
  pathMappedBy: null,
  label: '',
  description: '',
  nestUnderFiles: true,
  schemaType: '',
  frontmatterText: '',
  tags: [],
  taxonomyRoot: null,
  taxonomyLinks: [],
  visibility: 'shared',
  enabled: true,
});

const draftFrom = (m: FsMapping): Draft => ({
  id: m.id,
  rootKey: m.rootKey,
  relPath: m.relPath,
  pathMappedBy: null,
  label: m.label,
  description: m.description ?? '',
  nestUnderFiles: m.nestUnderFiles,
  schemaType: m.schema.type ?? '',
  frontmatterText: m.schema.frontmatter ? JSON.stringify(m.schema.frontmatter, null, 2) : '',
  tags: m.tags,
  taxonomyRoot: m.taxonomyRoot ?? null,
  taxonomyLinks: m.taxonomyLinks,
  visibility: m.visibility,
  enabled: m.enabled,
});

type FmIssue = { kind: 'invalid' } | { kind: 'reserved'; keys: string[] } | null;

/** JSON-validate the frontmatter template; reserved keys are only flagged. */
function checkFrontmatter(text: string): FmIssue {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { kind: 'invalid' };
    const reserved = Object.keys(v).filter((k) => RESERVED_FM_KEYS.includes(k));
    return reserved.length > 0 ? { kind: 'reserved', keys: reserved } : null;
  } catch {
    return { kind: 'invalid' };
  }
}

function timeAgo(iso: string, locale: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export function FsMappingsPanel() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const graph = useGraph();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [fmIssue, setFmIssue] = useState<FmIssue>(null);
  const [tagInput, setTagInput] = useState('');
  const [linkPick, setLinkPick] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FsMapping | null>(null);

  const { data: rootsData } = useQuery({
    queryKey: ['fs-roots'],
    queryFn: () => fsMappingsApi.roots(),
  });
  const { data: mappings = [] } = useQuery({
    queryKey: ['fs-mappings'],
    queryFn: () => fsMappingsApi.list(),
  });
  const { data: usedTypes = [] } = useQuery({
    queryKey: ['object-types'],
    queryFn: () => objectsApi.types(),
  });

  const roots = rootsData?.roots ?? [];
  const nodeById = useMemo(
    () => new Map((graph.data?.nodes ?? []).map((n) => [n.id, n])),
    [graph.data],
  );
  const labelFor = (id: string) => mappings.find((m) => m.id === id)?.label ?? id;

  /** "01 Science › 01.02 Physics" — ancestor chain resolved from the graph. */
  const ancestorPath = (nodeId: string): string | null => {
    const parts: string[] = [];
    for (let n = nodeById.get(nodeId); n; n = n.parentId ? nodeById.get(n.parentId) : undefined) {
      parts.unshift(n.name);
    }
    return parts.length > 0 ? parts.join(' › ') : null;
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['fs-mappings'] });
    queryClient.invalidateQueries({ queryKey: ['graph'] });
    queryClient.invalidateQueries({ queryKey: ['objects'] });
  };

  const failToast = (e: Error) => {
    const msg = e.message ?? '';
    const description = msg.startsWith('overlaps')
      ? t('admin.fsMappings.overlapError', { detail: /\(([^)]*)\)\s*$/.exec(msg)?.[1] ?? msg })
      : msg;
    toast({ title: t('common.error'), description, variant: 'destructive' });
  };

  const save = useMutation({
    // Normalizes create's firstSync and PATCH's resync into one `sync` field
    // so the success toast can carry real counts either way.
    mutationFn: async (d: Draft): Promise<{ sync: FsMappingSyncResult | null }> => {
      const body: FsMappingDraft = {
        rootKey: d.rootKey,
        relPath: d.relPath ?? '',
        label: d.label.trim(),
        description: d.description.trim() || null,
        nestUnderFiles: d.nestUnderFiles,
        schema: {
          ...(d.schemaType.trim() ? { type: d.schemaType.trim() } : {}),
          ...(d.frontmatterText.trim() ? { frontmatter: JSON.parse(d.frontmatterText) } : {}),
        },
        tags: d.tags,
        taxonomyRoot: d.taxonomyRoot,
        taxonomyLinks: d.taxonomyLinks,
        visibility: d.visibility,
        enabled: d.enabled,
      };
      if (d.id) {
        const r = await fsMappingsApi.update(d.id, body);
        return { sync: r.resync };
      }
      const r = await fsMappingsApi.create(body);
      return { sync: r.firstSync };
    },
    onSuccess: ({ sync }) => {
      invalidate();
      setDraft(null);
      setFmIssue(null);
      toast({
        title: t('common.success'),
        description: sync
          ? t('admin.fsMappings.saved', { count: sync.upserted })
          : t('admin.fsMappings.savedNoSync'),
      });
    },
    onError: failToast,
  });

  const syncNow = useMutation({
    mutationFn: (id: string) => fsMappingsApi.sync(id),
    onSuccess: (r) => {
      invalidate();
      toast({
        title: t('common.success'),
        description: t('admin.fsMappings.syncDone', {
          scanned: r.scanned, upserted: r.upserted, removed: r.removed,
        }),
      });
    },
    onError: failToast,
  });

  const remove = useMutation({
    mutationFn: (id: string) => fsMappingsApi.remove(id),
    onSuccess: (r) => {
      invalidate();
      setDeleteTarget(null);
      toast({
        title: t('common.success'),
        description: t('admin.fsMappings.deleted', { count: r.removedObjects }),
      });
    },
    onError: failToast,
  });

  const addTag = () => {
    const v = tagInput.trim().replace(/,+$/, '');
    if (!draft || !v) return;
    if (!draft.tags.includes(v)) setDraft({ ...draft, tags: [...draft.tags, v] });
    setTagInput('');
  };

  const addLink = () => {
    if (!draft || !linkPick) return;
    // Dupes and the primary root are rejected client-side (server dedupes too).
    if (
      linkPick !== draft.taxonomyRoot &&
      !draft.taxonomyLinks.includes(linkPick) &&
      draft.taxonomyLinks.length < MAX_TAXONOMY_LINKS
    ) {
      setDraft({ ...draft, taxonomyLinks: [...draft.taxonomyLinks, linkPick] });
    }
    setLinkPick(null);
  };

  const typeOptions = [...new Set([...usedTypes, ...CANONICAL_ASSET_TYPES])];
  const saveBlocked =
    !draft ||
    !draft.label.trim() ||
    draft.relPath === null ||
    fmIssue?.kind === 'invalid' ||
    (draft.pathMappedBy !== null && draft.pathMappedBy !== draft.id);

  /** Anchor chip: bold root vs outline link; amber when the node vanished
   *  (deleted ext taxonomy node) — the tether returns on re-approval. */
  const anchorChip = (id: string, isRoot: boolean) => {
    const node = nodeById.get(id);
    if (!node && graph.data) {
      return (
        <Badge key={id} variant="outline" className="border-amber-500 text-amber-500 text-[10px]">
          <TriangleAlert className="mr-1 h-3 w-3" />
          {id} · {t('admin.fsMappings.warnDanglingAnchor')}
        </Badge>
      );
    }
    return (
      <Badge key={id} variant="outline" className={`text-[10px] ${isRoot ? 'font-semibold' : 'font-normal'}`}>
        {node ? `${id} ${node.name}` : id}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      {/* Status strip: mounted roots + the per-user tree line. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <FolderSymlink className="w-5 h-5" />
              {t('admin.fsMappings.title')}
            </span>
            {!draft && (
              <Button size="sm" onClick={() => setDraft(emptyDraft(roots[0]?.key ?? ''))} disabled={roots.length === 0}>
                <Plus className="w-4 h-4 mr-1" />
                {t('admin.fsMappings.add')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {roots.length === 0 ? (
            <Alert>
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>{t('admin.fsMappings.noRoots')}</AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2">
              <Label>{t('admin.fsMappings.rootsTitle')}</Label>
              <div className="flex flex-wrap gap-2">
                {roots.map((r) => (
                  <Badge key={r.key} variant={r.exists ? 'secondary' : 'destructive'} className="font-mono text-xs">
                    <span
                      className={`mr-1.5 inline-block h-2 w-2 rounded-full ${r.exists ? 'bg-emerald-500' : 'bg-red-500'}`}
                    />
                    {r.key} · {r.path}
                    {!r.exists && ` · ${t('admin.fsMappings.rootMissing')}`}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t('admin.fsMappings.userFilesLine', { dir: rootsData?.userFiles.dir ?? '—' })}
          </p>

          {/* Inline create/edit form. */}
          {draft && (
            <div className="space-y-4 rounded-lg border border-border p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="fsm-root">{t('admin.fsMappings.root')}</Label>
                  <select
                    id="fsm-root"
                    value={draft.rootKey}
                    onChange={(e) =>
                      setDraft({ ...draft, rootKey: e.target.value, relPath: null, pathMappedBy: null })
                    }
                    className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  >
                    {roots.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.key}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>{t('admin.fsMappings.path')}</Label>
                  <p className="mt-2 font-mono text-sm">
                    {draft.relPath === null
                      ? t('admin.fsMappings.browse')
                      : `${draft.rootKey}/${draft.relPath}`}
                  </p>
                  {draft.pathMappedBy !== null && draft.pathMappedBy !== draft.id && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-500">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      {t('admin.fsMappings.alreadyMapped', { label: labelFor(draft.pathMappedBy) })}
                    </p>
                  )}
                </div>
              </div>

              <FolderBrowser
                key={draft.rootKey + (draft.id ?? '')}
                root={draft.rootKey}
                initialPath={draft.relPath ?? ''}
                editingId={draft.id}
                labelFor={labelFor}
                onUse={(relPath, mappedBy) => setDraft({ ...draft, relPath, pathMappedBy: mappedBy })}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="fsm-label">{t('admin.fsMappings.label')}</Label>
                  <Input
                    id="fsm-label"
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  />
                  {!draft.label.trim() && (
                    <p className="text-xs text-muted-foreground mt-1">{t('admin.fsMappings.labelRequired')}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="fsm-desc">{t('admin.fsMappings.description')}</Label>
                  <Input
                    id="fsm-desc"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="fsm-nest"
                  checked={draft.nestUnderFiles}
                  onCheckedChange={(v) => setDraft({ ...draft, nestUnderFiles: Boolean(v) })}
                />
                <div>
                  <Label htmlFor="fsm-nest">{t('admin.fsMappings.nestUnderFiles')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {draft.nestUnderFiles ? t('admin.fsMappings.nestHint') : t('admin.fsMappings.standaloneHint')}
                  </p>
                </div>
              </div>

              {/* Object template: type override + static frontmatter. */}
              <details open={Boolean(draft.schemaType || draft.frontmatterText)}>
                <summary className="cursor-pointer text-sm font-medium">
                  {t('admin.fsMappings.schemaTitle')}
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="fsm-type">{t('admin.fsMappings.schemaType')}</Label>
                    <Input
                      id="fsm-type"
                      list="fsm-type-options"
                      value={draft.schemaType}
                      onChange={(e) => setDraft({ ...draft, schemaType: e.target.value })}
                      placeholder={t('admin.fsMappings.schemaTypeAuto')}
                    />
                    <datalist id="fsm-type-options">
                      {typeOptions.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <Label htmlFor="fsm-fm">{t('admin.fsMappings.schemaFrontmatter')}</Label>
                    <Textarea
                      id="fsm-fm"
                      rows={4}
                      className="font-mono text-sm"
                      value={draft.frontmatterText}
                      onChange={(e) => setDraft({ ...draft, frontmatterText: e.target.value })}
                      onBlur={() => setFmIssue(checkFrontmatter(draft.frontmatterText))}
                      placeholder='{"collection": "family"}'
                    />
                    {fmIssue?.kind === 'invalid' && (
                      <p className="text-xs text-destructive mt-1">{t('admin.fsMappings.invalidJson')}</p>
                    )}
                    {fmIssue?.kind === 'reserved' && (
                      <p className="text-xs text-amber-500 mt-1">
                        {t('admin.fsMappings.reservedKeys', { keys: fmIssue.keys.join(', ') })}
                      </p>
                    )}
                  </div>
                </div>
              </details>

              <div>
                <Label htmlFor="fsm-tags">{t('admin.fsMappings.tags')}</Label>
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  {draft.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                      <button
                        type="button"
                        className="ml-1 hover:text-destructive"
                        onClick={() => setDraft({ ...draft, tags: draft.tags.filter((x) => x !== tag) })}
                        aria-label={t('common.delete')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <Input
                  id="fsm-tags"
                  className="mt-2"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  onBlur={addTag}
                  placeholder="tag1, tag2"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>{t('admin.fsMappings.taxonomyRoot')}</Label>
                  <TaxonomySelect
                    value={draft.taxonomyRoot ?? undefined}
                    onChange={(v) => setDraft({ ...draft, taxonomyRoot: v })}
                  />
                  {draft.taxonomyRoot && ancestorPath(draft.taxonomyRoot) && (
                    <p className="text-xs text-muted-foreground mt-1">{ancestorPath(draft.taxonomyRoot)}</p>
                  )}
                </div>
                <div>
                  <Label>{t('admin.fsMappings.taxonomyLinks')}</Label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <TaxonomySelect value={linkPick ?? undefined} onChange={setLinkPick} />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={addLink}
                      disabled={!linkPick || draft.taxonomyLinks.length >= MAX_TAXONOMY_LINKS}
                    >
                      {t('admin.fsMappings.addLink')}
                    </Button>
                  </div>
                  {draft.taxonomyLinks.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {draft.taxonomyLinks.map((id) => (
                        <Badge key={id} variant="outline" className="text-xs">
                          {nodeById.get(id) ? `${id} ${nodeById.get(id)!.name}` : id}
                          <button
                            type="button"
                            className="ml-1 hover:text-destructive"
                            onClick={() =>
                              setDraft({ ...draft, taxonomyLinks: draft.taxonomyLinks.filter((x) => x !== id) })
                            }
                            aria-label={t('common.delete')}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="fsm-visibility">{t('admin.fsMappings.visibility')}</Label>
                  <select
                    id="fsm-visibility"
                    value={draft.visibility}
                    onChange={(e) => setDraft({ ...draft, visibility: e.target.value as 'shared' | 'private' })}
                    className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  >
                    <option value="shared">{t('admin.fsMappings.visibilityShared')}</option>
                    <option value="private">{t('admin.fsMappings.visibilityPrivate')}</option>
                  </select>
                </div>
                <div className="flex items-center gap-3 pt-6">
                  <Checkbox
                    id="fsm-enabled"
                    checked={draft.enabled}
                    onCheckedChange={(v) => setDraft({ ...draft, enabled: Boolean(v) })}
                  />
                  <Label htmlFor="fsm-enabled">{t('admin.fsMappings.enabled')}</Label>
                </div>
              </div>

              <div className="flex gap-2">
                <Button onClick={() => save.mutate(draft)} disabled={saveBlocked || save.isPending}>
                  {t('common.save')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft(null);
                    setFmIssue(null);
                    setTagInput('');
                    setLinkPick(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {/* Mapping list. */}
          {mappings.length === 0 && !draft ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>{t('admin.fsMappings.empty')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {mappings.map((m) => {
                const ls = m.status.lastSync;
                return (
                  <div key={m.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{m.label}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {m.rootKey}/{m.relPath}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {m.nestUnderFiles ? t('admin.fsMappings.nested') : t('admin.fsMappings.standalone')}
                          </Badge>
                          <Badge variant={m.enabled ? 'secondary' : 'outline'} className="text-[10px]">
                            {m.enabled ? t('admin.fsMappings.enabled') : t('admin.fsMappings.disabled')}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {m.visibility === 'shared'
                              ? t('admin.fsMappings.visibilityShared')
                              : t('admin.fsMappings.visibilityPrivate')}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            {m.schema.type ?? t('admin.fsMappings.schemaTypeAuto')}
                          </Badge>
                          {m.tags.map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px]">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                        {(m.taxonomyRoot || m.taxonomyLinks.length > 0) && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {m.taxonomyRoot && anchorChip(m.taxonomyRoot, true)}
                            {m.taxonomyLinks.map((id) => anchorChip(id, false))}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                          <span>{t('admin.fsMappings.objectCount', { count: m.status.objectCount })}</span>
                          <span>
                            {ls
                              ? t('admin.fsMappings.lastSync', {
                                  scanned: ls.scanned,
                                  changed: ls.upserted + ls.removed,
                                  tookMs: ls.tookMs,
                                  ago: ls.at ? timeAgo(ls.at, i18n.language) : '—',
                                })
                              : t('admin.fsMappings.neverSynced')}
                          </span>
                          {ls?.capped && (
                            <Badge variant="outline" className="border-amber-500 text-amber-500 text-[10px]">
                              {t('admin.fsMappings.warnCapped')}
                            </Badge>
                          )}
                          {ls?.pruneRefused && (
                            <Badge variant="outline" className="border-amber-500 text-amber-500 text-[10px]">
                              {t('admin.fsMappings.warnPruneRefused')}
                            </Badge>
                          )}
                          {!m.status.rootAvailable && (
                            <Badge variant="destructive" className="text-[10px]">
                              {t('admin.fsMappings.warnRootMissing')}
                            </Badge>
                          )}
                          {ls?.error && (
                            <Badge variant="destructive" className="text-[10px]" title={ls.error}>
                              {t('admin.fsMappings.warnError')}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => syncNow.mutate(m.id)}
                          disabled={syncNow.isPending || !m.enabled}
                          aria-label={t('admin.fsMappings.syncNow')}
                          title={t('admin.fsMappings.syncNow')}
                        >
                          <RefreshCw
                            className={`w-4 h-4 ${syncNow.isPending && syncNow.variables === m.id ? 'animate-spin motion-reduce:animate-none' : ''}`}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDraft(draftFrom(m));
                            setFmIssue(null);
                          }}
                          aria-label={t('admin.fsMappings.edit')}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(m)}
                          aria-label={t('admin.fsMappings.delete')}
                        >
                          <Trash className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirm — always shows the object count that will go with it. */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.fsMappings.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.fsMappings.deleteBody', { count: deleteTarget?.status.objectCount ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}>
              {t('admin.fsMappings.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
