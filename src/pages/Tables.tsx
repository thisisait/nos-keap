/**
 * /tables — data-table list + creation with the STORAGE PICKER (Track R2′).
 * The picker is honest: it reads driver capabilities from the server and
 * pitches each storage by what it actually offers (transactions & instant
 * events vs. object versioning & lifecycle) — unavailable drivers render
 * disabled with the reason.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Table2, Trash, Database, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { tablesApi } from '@/services/api/tables';
import type {
  ColumnDef,
  ColumnKind,
  ColumnRole,
  TableDriver,
  TableVisibilityContract,
} from '../../shared/contracts/table';

const COLUMN_KINDS: ColumnKind[] = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'json',
  'file',
  'vector',
  'taxonomyRef',
  'objectRef',
  'user',
];
const ROLES: ColumnRole[] = ['attribute', 'dimension', 'measure'];
const VISIBILITIES: TableVisibilityContract[] = [
  'private',
  'tier-managers',
  'tier-users',
  'tier-guests',
  'shared',
];

interface DraftColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  role: ColumnRole;
  required: boolean;
  options: string;
  dim: string;
}

const EMPTY_COLUMN: DraftColumn = {
  key: '',
  label: '',
  kind: 'text',
  role: 'attribute',
  required: false,
  options: '',
  dim: '',
};

export default function Tables() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [driver, setDriver] = useState<TableDriver>('libsql');
  const [anchor, setAnchor] = useState('');
  const [visibility, setVisibility] = useState<TableVisibilityContract>('private');
  const [columns, setColumns] = useState<DraftColumn[]>([{ ...EMPTY_COLUMN }]);

  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: tablesApi.list });
  const { data: drivers = [] } = useQuery({ queryKey: ['table-drivers'], queryFn: tablesApi.drivers });

  const create = useMutation({
    mutationFn: () => {
      const schemaColumns: ColumnDef[] = columns
        .filter((c) => c.key.trim() && c.label.trim())
        .map((c) => ({
          key: c.key.trim(),
          label: c.label.trim(),
          kind: c.kind,
          role: c.role,
          required: c.required,
          options: c.kind === 'select' && c.options ? c.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          dim: c.kind === 'vector' && c.dim ? Number(c.dim) : undefined,
        }));
      return tablesApi.create({
        title: title.trim(),
        driver,
        schema: { columns: schemaColumns },
        anchors: anchor.trim() ? [anchor.trim()] : [],
        visibility,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tables'] });
      queryClient.invalidateQueries({ queryKey: ['graph'] });
      setCreating(false);
      setTitle('');
      setVisibility('private');
      setColumns([{ ...EMPTY_COLUMN }]);
      toast({ title: t('common.success'), description: t('tables.created') });
    },
    onError: (e) =>
      toast({ title: t('common.error'), description: e instanceof Error ? e.message : t('tables.createFailed'), variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => tablesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tables'] });
      toast({ title: t('common.success'), description: t('tables.deleted') });
    },
  });

  const share = useMutation({
    mutationFn: ({ id, visibility }: { id: string; visibility: TableVisibilityContract }) =>
      tablesApi.setVisibility(id, visibility),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tables'] });
      toast({ title: t('common.success'), description: t('tables.shareUpdated') });
    },
    onError: (e) =>
      toast({ title: t('common.error'), description: e instanceof Error ? e.message : t('tables.shareFailed'), variant: 'destructive' }),
  });

  const setCol = (i: number, patch: Partial<DraftColumn>) =>
    setColumns((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="container mx-auto flex h-14 items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:text-primary">
            <ArrowLeft className="h-4 w-4" />
            {t('common.home')}
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">{t('tables.title')}</h1>
          <Button size="sm" className="ml-auto" onClick={() => setCreating((v) => !v)}>
            <Plus className="mr-1 h-4 w-4" />
            {t('tables.new')}
          </Button>
        </div>
      </header>

      <main className="container mx-auto space-y-6 px-4 py-6">
        {creating && (
          <Card>
            <CardHeader>
              <CardTitle>{t('tables.new')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="tbl-title">{t('tables.name')}</Label>
                  <Input id="tbl-title" value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="tbl-anchor">{t('tables.anchor')}</Label>
                  <Input
                    id="tbl-anchor"
                    value={anchor}
                    onChange={(e) => setAnchor(e.target.value)}
                    placeholder="01.02"
                  />
                </div>
              </div>

              {/* Storage picker — capabilities straight from the server */}
              <div>
                <Label>{t('tables.storage')}</Label>
                <div className="mt-1 grid gap-2 md:grid-cols-2">
                  {drivers.map((d) => (
                    <button
                      key={d.driver}
                      type="button"
                      disabled={!d.available}
                      onClick={() => setDriver(d.driver)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        driver === d.driver ? 'border-primary bg-primary/5' : 'border-border'
                      } ${d.available ? 'hover:border-primary/50' : 'opacity-50'}`}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {d.driver === 'libsql' ? <Database className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                        {t(`tables.drivers.${d.driver}.name`)}
                        {!d.available && <Badge variant="outline">{t('tables.unavailable')}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(`tables.drivers.${d.driver}.pitch`)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {d.capabilities.transactions && <Badge variant="secondary">{t('tables.caps.transactions')}</Badge>}
                        {d.capabilities.rowHistory && <Badge variant="secondary">{t('tables.caps.history')}</Badge>}
                        {d.capabilities.objectVersioning && <Badge variant="secondary">{t('tables.caps.versioning')}</Badge>}
                        {d.capabilities.aggregate && <Badge variant="secondary">{t('tables.caps.aggregate')}</Badge>}
                        {d.capabilities.events && <Badge variant="secondary">{t('tables.caps.events')}</Badge>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Column editor */}
              <div className="space-y-2">
                <Label>{t('tables.columns')}</Label>
                {columns.map((c, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2 md:grid-cols-7">
                    <Input placeholder={t('tables.colKey')} value={c.key} onChange={(e) => setCol(i, { key: e.target.value })} />
                    <Input placeholder={t('tables.colLabel')} value={c.label} onChange={(e) => setCol(i, { label: e.target.value })} />
                    <select
                      className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                      value={c.kind}
                      onChange={(e) => setCol(i, { kind: e.target.value as ColumnKind })}
                    >
                      {COLUMN_KINDS.map((k) => (
                        <option key={k} value={k}>{t(`tables.kinds.${k}`)}</option>
                      ))}
                    </select>
                    <select
                      className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                      value={c.role}
                      onChange={(e) => setCol(i, { role: e.target.value as ColumnRole })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{t(`tables.roles.${r}`)}</option>
                      ))}
                    </select>
                    {c.kind === 'select' ? (
                      <Input placeholder={t('tables.colOptions')} value={c.options} onChange={(e) => setCol(i, { options: e.target.value })} />
                    ) : c.kind === 'vector' ? (
                      <Input placeholder="dim" type="number" value={c.dim} onChange={(e) => setCol(i, { dim: e.target.value })} />
                    ) : (
                      <div />
                    )}
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox checked={c.required} onCheckedChange={(on) => setCol(i, { required: Boolean(on) })} />
                      {t('tables.colRequired')}
                    </label>
                    <Button variant="ghost" size="sm" onClick={() => setColumns((prev) => prev.filter((_, j) => j !== i))}>
                      <Trash className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setColumns((prev) => [...prev, { ...EMPTY_COLUMN }])}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t('tables.addColumn')}
                </Button>
              </div>

              <div>
                <Label htmlFor="tbl-visibility">{t('tables.shareScope')}</Label>
                <select
                  id="tbl-visibility"
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-2 text-sm md:w-72"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as TableVisibilityContract)}
                >
                  {VISIBILITIES.map((v) => (
                    <option key={v} value={v}>
                      {t(`tables.visibility.${v}`)}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`tables.visibilityHint.${visibility}`)}
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  disabled={create.isPending || !title.trim() || !columns.some((c) => c.key && c.label)}
                  onClick={() => create.mutate()}
                >
                  {t('common.save')}
                </Button>
                <Button variant="outline" onClick={() => setCreating(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {tables.length === 0 && !creating ? (
          <div className="py-16 text-center text-muted-foreground">
            <Table2 className="mx-auto mb-3 h-10 w-10 opacity-40" />
            <p>{t('tables.empty')}</p>
            <p className="mt-1 text-sm">{t('tables.emptyHint')}</p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {tables.map((tbl) => (
              <Card key={tbl.id} className="transition-transform hover:scale-[1.01] motion-reduce:hover:scale-100">
                <CardContent className="flex items-start justify-between gap-2 p-4">
                  <Link to={`/tables/${tbl.id}`} className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      <Table2 className="h-4 w-4 shrink-0" />
                      <span className="truncate">{tbl.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('tables.meta', { rows: tbl.rowCount, cols: tbl.schema.columns.length })}
                      {' · '}
                      {t(`tables.drivers.${tbl.driver}.name`)}
                    </p>
                  </Link>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(tbl.id)}>
                      <Trash className="h-4 w-4" />
                    </Button>
                    {/* Owner/admin can re-scope sharing after creation (PATCH). */}
                    <select
                      className="h-7 max-w-[8.5rem] rounded-md border border-input bg-background px-1 text-xs"
                      value={VISIBILITIES.includes(tbl.visibility as TableVisibilityContract) ? tbl.visibility : 'private'}
                      onChange={(e) =>
                        share.mutate({ id: tbl.id, visibility: e.target.value as TableVisibilityContract })
                      }
                      title={t('tables.shareScope')}
                      aria-label={t('tables.shareScope')}
                    >
                      {VISIBILITIES.map((v) => (
                        <option key={v} value={v}>
                          {t(`tables.visibility.${v}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
