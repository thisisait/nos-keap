/**
 * The constellation control panel: relation mode, source kinds, dataType
 * facets, and the distance-sorted result list. What is checked here decides
 * which stars get rendered behind the focused branch.
 */
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { NeighborItem, NeighborMode } from '@/hooks/useExplorerData';

interface Props {
  focusName: string | null;
  mode: NeighborMode;
  onModeChange: (m: NeighborMode) => void;
  kinds: string[];
  onKindsChange: (k: string[]) => void;
  typeFilter: Set<string>;
  onTypeToggle: (t: string) => void;
  availableTypes: string[];
  items: NeighborItem[];
  loading: boolean;
  semantic: boolean;
  vectorsReady: boolean;
  onItemClick: (item: NeighborItem) => void;
}

const KINDS = ['taxonomy', 'capture', 'note'] as const;

export default function SidePanel({
  focusName,
  mode,
  onModeChange,
  kinds,
  onKindsChange,
  typeFilter,
  onTypeToggle,
  availableTypes,
  items,
  loading,
  semantic,
  vectorsReady,
  onItemClick,
}: Props) {
  const { t } = useTranslation();

  const filtered = typeFilter.size
    ? items.filter((i) => i.dataType && typeFilter.has(i.dataType))
    : items;

  return (
    <div className="flex h-full w-72 flex-col gap-4 border-l bg-background/80 p-4 backdrop-blur">
      <div>
        <h2 className="text-sm font-semibold">{t('explore.panel.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {focusName ? t('explore.panel.focusOn', { name: focusName }) : t('explore.panel.noFocus')}
        </p>
      </div>

      {!vectorsReady && (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          {t('explore.panel.noVectors')}
        </p>
      )}

      <div className="flex gap-1">
        {(['related', 'unrelated'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className={`rounded-md px-2 py-1 text-xs transition-colors ${
              mode === m ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {t(`explore.mode.${m}`)}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t('explore.panel.kinds')}</p>
        {KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={kinds.includes(k)}
              onCheckedChange={(on) =>
                onKindsChange(on ? [...kinds, k] : kinds.filter((x) => x !== k))
              }
            />
            {t(`explore.kind.${k}`)}
          </label>
        ))}
      </div>

      {availableTypes.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('explore.panel.dataTypes')}</p>
          <div className="flex flex-wrap gap-1">
            {availableTypes.map((dt) => (
              <Badge
                key={dt}
                variant={typeFilter.size === 0 || typeFilter.has(dt) ? 'default' : 'outline'}
                className="cursor-pointer text-[10px]"
                onClick={() => onTypeToggle(dt)}
              >
                {dt}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          {t('explore.panel.results', { count: filtered.length })}
          {!semantic && focusName ? ` · ${t('explore.panel.notSemantic')}` : ''}
        </p>
        <ScrollArea className="h-full pr-2">
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <ul className="space-y-1">
              {filtered.map((item) => (
                <li key={`${item.kind}:${item.refId}`}>
                  <button
                    onClick={() => onItemClick(item)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {item.distance?.toFixed(2)}
                      </span>
                    </span>
                    {item.dataType && (
                      <span className="text-[10px] text-muted-foreground">{item.dataType}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
