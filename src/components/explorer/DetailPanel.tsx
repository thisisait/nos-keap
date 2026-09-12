/**
 * The ONE right rail: everything about the selected thing, in reading order —
 * breadcrumb → name (type, zone) → prose (brief) → "Uvnitř" (children +
 * folder contents) → "Souvisí" (anchored objects, [[object:…]] links, typed
 * relations grouped by verb) → "Otevřít kde žije". Renders content-only so
 * the page can mount it as the desktop rail or inside the mobile Sheet.
 *
 * Authoring (Describe / New sub-node) deliberately lives elsewhere — the
 * admin/moderation page and the agent door — not in the map.
 */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Crosshair, X, ChevronRight, Folder, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/services/api/client';
import type { GraphNode, GraphObject, GraphObjectLink } from '@/hooks/useExplorerData';
import { fmtBytes, type RepoLang } from './repoVisuals';

/** Direct child of a core folder hub — subfolder or contained object. */
export interface FolderChild {
  id: string;
  name: string;
  folder?: boolean;
  count?: number;
  dataType?: string;
}

export interface DrawerTarget {
  id: string;
  name: string;
  kind: string;
  dataType?: string;
  description?: string;
  url?: string;
  isStar: boolean;
  nodeId?: string;
  /** Core folder hubs only: fs path ('' = root) + direct contents. */
  path?: string;
  children?: FolderChild[];
  /** Repo folder hubs: subtree size + primary-language mix. */
  repo?: boolean;
  bytes?: number;
  langs?: RepoLang[];
}

/** One typed edge as the rail needs it: which verb, which way, and the far end. */
export interface FocusRelation {
  type: string;
  /** Registry label ("Depends on"); falls back to the raw verb. */
  label: string;
  color?: string;
  confidence?: number;
  /** 'out' = target → other, 'in' = other → target. */
  direction: 'out' | 'in';
  otherRef: string;
  otherKind: 'node' | 'object';
  otherName: string;
}

interface Props {
  target: DrawerTarget | null;
  nodeById: Map<string, GraphNode>;
  objects: GraphObject[];
  /** Object→object ref edges (bare ids) — the "Souvisí" linked-card rows. */
  objectLinks: GraphObjectLink[];
  /** Confirmed typed relations touching the target, either direction. */
  relations?: FocusRelation[];
  onRelationClick?: (r: FocusRelation) => void;
  onClose: () => void;
  onFocus: (nodeId: string) => void;
  onSelect: (id: string) => void;
  /** Slice the map to this taxonomy node's subtree (?root=). */
  onSliceRoot?: (nodeId: string) => void;
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

/**
 * Markdown-lite for node briefs: paragraphs + two link forms. [[node-id]]
 * becomes a clickable vazba into the universe (label = node name); standard
 * [text](url) opens the external source. No markdown lib — briefs are
 * validated server-side to exactly these shapes.
 */
function BriefBody({
  md,
  nodeById,
  onSelect,
}: {
  md: string;
  nodeById: Map<string, GraphNode>;
  onSelect: (id: string) => void;
}) {
  const renderInline = (text: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /\[\[([^\]]+)\]\]|\[([^\]]*)\]\(([^)\s]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] !== undefined) {
        const id = m[1];
        out.push(
          <button
            key={key++}
            className="text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
            onClick={() => onSelect(id)}
          >
            {nodeById.get(id)?.name ?? id}
          </button>,
        );
      } else {
        // Only http(s) links become anchors — a brief is untrusted LLM/user
        // text, and React does not neutralize `javascript:` hrefs. Anything
        // else renders as plain text (label + URL), never an executable link.
        const href = m[3];
        const safe = /^https?:\/\//i.test(href);
        out.push(
          safe ? (
            <a key={key++} href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              {m[2] || href}
            </a>
          ) : (
            <span key={key++}>{m[2] ? `${m[2]} (${href})` : href}</span>
          ),
        );
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
  return (
    <div className="space-y-2">
      {md.split(/\n\s*\n/).filter((p) => p.trim()).map((p, i) => (
        <p key={i} className="text-xs leading-relaxed text-muted-foreground">{renderInline(p.trim())}</p>
      ))}
    </div>
  );
}

/** Shared row: badge + title, click → onSelect. Every list in the rail is this shape. */
function CardRow({ o, onSelect, prefix }: { o: GraphObject; onSelect: (id: string) => void; prefix?: string }) {
  return (
    <li>
      <button
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60"
        onClick={() => onSelect(`obj:${o.id}`)}
      >
        {prefix && <span className="shrink-0 text-muted-foreground">{prefix}</span>}
        <Badge variant="outline" className="shrink-0 px-1 text-[9px]">{o.type}</Badge>
        <span className="truncate">{o.title}</span>
      </button>
    </li>
  );
}

export default function DetailPanel({
  target,
  nodeById,
  objects,
  objectLinks,
  relations = [],
  onRelationClick,
  onClose,
  onFocus,
  onSelect,
  onSliceRoot,
}: Props) {
  const { t, i18n } = useTranslation();

  const node = target && !target.isStar ? nodeById.get(target.id) : null;
  // Curated note layer — the node's brief (taxonomy-brief skill output) plus
  // the K1 description, which the bulk graph payload no longer carries.
  const { data: curatedRow } = useQuery<{
    data?: { brief?: string; briefCs?: string; [key: string]: unknown };
    description?: string;
    descriptionCs?: string;
  } | null>({
    queryKey: ['node-meta', node?.id],
    queryFn: () => apiFetch(`/api/taxonomy-metadata/${node!.id}`),
    enabled: Boolean(node),
  });
  const brief = curatedRow?.data
    ? (i18n.language?.startsWith('cs') && curatedRow.data.briefCs) ||
        curatedRow.data.brief
    : undefined;
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
  // Object rail: [[object:<id>]] ref edges resolved to cards, both directions.
  const bareObjId = target?.id.startsWith('obj:') ? target.id.slice(4) : null;
  const objById = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects]);
  const linked = useMemo(() => {
    if (!bareObjId) return [] as { o: GraphObject; dir: 'out' | 'in' }[];
    const out: { o: GraphObject; dir: 'out' | 'in' }[] = [];
    for (const l of objectLinks) {
      if (l.source === bareObjId) {
        const o = objById.get(l.target);
        if (o) out.push({ o, dir: 'out' });
      } else if (l.target === bareObjId) {
        const o = objById.get(l.source);
        if (o) out.push({ o, dir: 'in' });
      }
    }
    return out;
  }, [bareObjId, objectLinks, objById]);

  // Typed relations grouped by VERB so the section reads as an ontology
  // ("Depends on: a, b") rather than a flat list. Direction is carried per row,
  // not per group: the registry has one label per verb and no inverse form.
  const relGroups = useMemo(() => {
    const by = new Map<string, { label: string; color?: string; rows: FocusRelation[] }>();
    for (const r of relations) {
      const g = by.get(r.type) ?? { label: r.label, color: r.color, rows: [] };
      g.rows.push(r);
      by.set(r.type, g);
    }
    for (const g of by.values()) g.rows.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    // Biggest group first — the node's dominant relation reads at the top.
    return [...by.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length);
  }, [relations]);

  if (!target) {
    return (
      <div className="flex h-full w-full flex-col bg-background/80 p-4 backdrop-blur">
        <h2 className="text-sm font-semibold">{t('explore.panel.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('explore.panel.noFocus')}</p>
      </div>
    );
  }

  const description = node
    ? (i18n.language?.startsWith('cs') && curatedRow?.descriptionCs) || curatedRow?.description
    : target.description;
  const prose = (node && brief) || description;
  const zone = node?.zone;
  const insideCount = (target.children?.length ?? 0) + children.length;
  const hasRelated = anchored.length > 0 || linked.length > 0 || relGroups.length > 0;

  return (
    <div className="flex h-full w-full flex-col bg-background/80 backdrop-blur">
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
          {target.path !== undefined && target.path !== '' && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{target.path}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {zone && (
              <Badge variant={zoneVariant[zone]} className="text-[10px]">
                {t(`explore.detail.zone.${zone}`)}
              </Badge>
            )}
            {target.kind === 'folder' && (
              <Badge variant="outline" className="text-[10px]">{t('explore.detail.folderBadge')}</Badge>
            )}
            {target.repo && <Badge className="text-[10px]">{t('explore.detail.repoBadge')}</Badge>}
            {target.repo && target.bytes !== undefined && (
              <span className="text-[11px] tabular-nums text-muted-foreground">{fmtBytes(target.bytes)}</span>
            )}
            {node?.ext && <Badge variant="outline" className="text-[10px]">{t('explore.detail.grown')}</Badge>}
            {target.dataType && <Badge variant="secondary" className="text-[10px]">{target.dataType}</Badge>}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose} aria-label={t('common.close')}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-3">
          {prose && <BriefBody md={prose} nodeById={nodeById} onSelect={onSelect} />}

          {target.repo && target.langs && target.langs.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('explore.detail.repoLangs')}
              </p>
              <div className="mb-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                {target.langs.map((l) => (
                  <div key={l.lang} style={{ width: `${l.pct * 100}%`, backgroundColor: l.color }} />
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {target.langs.map((l) => `${l.lang} ${(l.pct * 100).toFixed(0)} %`).join(' · ')}
              </p>
            </div>
          )}

          {/* Uvnitř — folder contents + taxonomy sub-nodes under ONE heading. */}
          {insideCount > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('explore.detail.inside', { count: insideCount })}
              </p>
              <ul className="space-y-0.5">
                {(target.children ?? []).map((c) => (
                  <li key={c.id}>
                    <button
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                      onClick={() => onSelect(c.id)}
                    >
                      {c.folder ? (
                        <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{c.name}</span>
                      {c.folder && (c.count ?? 0) > 0 && (
                        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">{c.count}</span>
                      )}
                      {!c.folder && c.dataType && (
                        <Badge variant="outline" className="ml-auto shrink-0 px-1 text-[9px]">{c.dataType}</Badge>
                      )}
                    </button>
                  </li>
                ))}
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
          ) : (
            target.kind === 'folder' && (
              <p className="text-xs italic text-muted-foreground/70">{t('explore.detail.folderEmpty')}</p>
            )
          )}

          {/* Souvisí — anchored cards, [[object:…]] links (→/←), typed verbs. */}
          {hasRelated && (
            <div data-testid="panel-relations">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('explore.detail.related')}
              </p>
              {(anchored.length > 0 || linked.length > 0) && (
                <ul className="space-y-0.5">
                  {anchored.map((o) => <CardRow key={o.id} o={o} onSelect={onSelect} />)}
                  {linked.map(({ o, dir }) => (
                    <CardRow key={`${dir}:${o.id}`} o={o} onSelect={onSelect} prefix={dir === 'out' ? '→' : '←'} />
                  ))}
                </ul>
              )}
              {relGroups.length > 0 && (
                <ol className="mt-2 space-y-2">
                  {relGroups.map(([type, g]) => (
                    <li key={type} data-testid={`relgroup-${type}`}>
                      <p className="flex items-center gap-1.5 text-[11px] font-medium">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: g.color ?? 'hsl(var(--primary))' }}
                        />
                        <span className="truncate">{g.label}</span>
                        <span className="shrink-0 text-muted-foreground">({g.rows.length})</span>
                      </p>
                      <ul className="mt-0.5 space-y-0.5 pl-3.5">
                        {g.rows.map((r) => (
                          <li key={`${r.direction}:${r.otherKind}:${r.otherRef}`}>
                            <button
                              onClick={() => onRelationClick?.(r)}
                              className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted"
                              title={r.direction === 'out' ? t('explore.panel.relOut') : t('explore.panel.relIn')}
                            >
                              <span className="shrink-0 text-muted-foreground">
                                {r.direction === 'out' ? '→' : '←'}
                              </span>
                              <span className="truncate">{r.otherName}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {/* Otevřít kde žije + focus/slice actions. */}
          <div className="flex flex-wrap gap-2">
            {/* Same law as BriefBody above: capture URLs arrive from the
                least-trusted intake surfaces and React does not neutralize
                javascript: hrefs — only http(s) earns an anchor. */}
            {/^https?:\/\//i.test(target.url ?? node?.url ?? '') && (
              <Button asChild size="sm" className="h-7 text-xs">
                <a href={target.url ?? node?.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1 h-3 w-3" />
                  {t('explore.detail.openWhere')}
                </a>
              </Button>
            )}
            {target.isStar && target.nodeId && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onFocus(target.nodeId!)}>
                <Crosshair className="mr-1 h-3 w-3" />
                {t('explore.drawer.focus')}
              </Button>
            )}
            {node && node.childCount > 0 && onSliceRoot && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                data-testid="detail-slice-root"
                onClick={() => onSliceRoot(node.id)}
              >
                {t('explore.detail.sliceRoot')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
