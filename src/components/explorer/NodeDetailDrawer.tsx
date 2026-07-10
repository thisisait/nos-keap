/**
 * Detail sheet for a selected point — taxonomy node or star (capture/note).
 * Resolves the content link client-side (same resolver the Admin CMS uses)
 * so a click lands directly in the live nOS service (Kiwix, Calibre, …).
 */
import { useTranslation } from 'react-i18next';
import { ExternalLink, Crosshair } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GraphNode } from '@/hooks/useExplorerData';

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
  onClose: () => void;
  onFocus: (nodeId: string) => void;
}

function ancestryPath(id: string, nodeById: Map<string, GraphNode>): string {
  const parts: string[] = [];
  let cur = nodeById.get(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
  }
  return parts.join(' › ');
}

export default function NodeDetailDrawer({ target, nodeById, onClose, onFocus }: Props) {
  const { t } = useTranslation();
  const node = target?.nodeId ? nodeById.get(target.nodeId) : target ? nodeById.get(target.id) : null;

  return (
    <Sheet open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="max-h-[45vh]">
        {target && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {target.isStar ? '☆' : null} {target.name}
                {target.dataType && <Badge variant="secondary">{target.dataType}</Badge>}
                {target.distance !== undefined && (
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    d = {target.distance.toFixed(3)}
                  </span>
                )}
              </SheetTitle>
              <SheetDescription>
                {node ? ancestryPath(node.id, nodeById) : target.kind}
              </SheetDescription>
            </SheetHeader>
            {target.description && (
              <p className="mt-2 text-sm text-muted-foreground">{target.description}</p>
            )}
            <div className="mt-4 flex gap-2">
              {target.url && (
                <Button asChild size="sm">
                  <a href={target.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-1 h-3.5 w-3.5" />
                    {t('explore.drawer.open')}
                  </a>
                </Button>
              )}
              {(target.nodeId || node) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onFocus(target.nodeId ?? target.id)}
                >
                  <Crosshair className="mr-1 h-3.5 w-3.5" />
                  {t('explore.drawer.focus')}
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
