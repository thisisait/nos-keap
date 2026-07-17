/**
 * Admin › Mapped folders — the folder picker (GET /api/fs/browse).
 * One directory level at a time: breadcrumbs ascend, dir rows descend,
 * the current level shows its file count + a sample of file names so the
 * admin sees WHAT would sync before committing. A path already covered by
 * another mapping shows the pre-emptive warning (the server would 409
 * anyway — this just spares the round trip) and blocks "Use this folder".
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Folder, ChevronRight, CornerLeftUp, TriangleAlert, Check } from 'lucide-react';
import { fsMappingsApi } from '@/services/api/fsMappings';

interface FolderBrowserProps {
  root: string;
  /** Starting path (edit reopens where the mapping points). */
  initialPath?: string;
  /** Mapping id being edited — its own coverage is not a conflict. */
  editingId?: string;
  /** Resolves a mapping id to its label for the already-mapped warning. */
  labelFor: (mappingId: string) => string;
  /** "Use this folder" — commits the browsed path into the draft. */
  onUse: (relPath: string, mappedBy: string | null) => void;
}

export function FolderBrowser({ root, initialPath = '', editingId, labelFor, onUse }: FolderBrowserProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState(initialPath);

  // Switching the root select invalidates any browsed position.
  useEffect(() => setPath(''), [root]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['fs-browse', root, path],
    queryFn: () => fsMappingsApi.browse(root, path),
    enabled: Boolean(root),
  });

  const crumbs = path === '' ? [] : path.split('/');
  const conflict = data && data.mappedBy !== null && data.mappedBy !== editingId ? data.mappedBy : null;

  return (
    <div className="rounded-md border border-border">
      {/* Breadcrumbs: root key, then one crumb per segment. */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-sm">
        <button
          type="button"
          className="font-mono text-xs hover:text-primary"
          onClick={() => setPath('')}
        >
          {root}
        </button>
        {crumbs.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              className="font-mono text-xs hover:text-primary"
              onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <div className="max-h-64 overflow-y-auto p-1">
        {isLoading ? (
          <p className="p-3 text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : error ? (
          <p className="p-3 text-sm text-destructive">{String((error as Error).message)}</p>
        ) : data ? (
          <>
            {path !== '' && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
                onClick={() => setPath(data.parent)}
              >
                <CornerLeftUp className="h-4 w-4 text-muted-foreground" />
                ..
              </button>
            )}
            {data.dirs.map((d) => (
              <button
                key={d.name}
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
                onClick={() => setPath(path === '' ? d.name : `${path}/${d.name}`)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{d.name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('admin.fsMappings.dirCounts', { dirs: d.dirCount, files: d.fileCount })}
                </span>
              </button>
            ))}
            {data.truncated && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {t('admin.fsMappings.truncatedList')}
              </p>
            )}
          </>
        ) : null}
      </div>

      {data && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t('admin.fsMappings.filesHere', { count: data.fileCount })}
            {data.sampleFiles.length > 0 && (
              <span className="ml-2 font-mono">{data.sampleFiles.join(' · ')}</span>
            )}
          </p>
          {conflict && (
            <p className="flex items-center gap-1.5 text-xs text-amber-500">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {t('admin.fsMappings.alreadyMapped', { label: labelFor(conflict) })}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={Boolean(conflict)}
            onClick={() => onUse(path, data.mappedBy)}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {t('admin.fsMappings.useFolder')}
          </Button>
        </div>
      )}
    </div>
  );
}
