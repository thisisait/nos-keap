/**
 * /tables/:id — the SharePoint-list grid editor (Track R2′).
 *
 * TanStack Table renders the schema-driven grid; cells edit inline by kind
 * (text/number straight input, boolean checkbox, select dropdown, complex
 * kinds — json/file/vector/refs — as JSON text). Sorting is server-side
 * (header click), an "add row" form row sits on top, and when the schema
 * declares dimensions × measures the OLAP summary bar renders a live
 * aggregate — the cube seed, visible from day one.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import { ArrowLeft, Plus, Trash, ArrowUp, ArrowDown, Sigma } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { tablesApi } from '@/services/api/tables';
import type { ColumnDef as SchemaColumn, TableRow } from '../../shared/contracts/table';

function parseCell(col: SchemaColumn, raw: string): unknown {
  if (raw === '') return undefined;
  switch (col.kind) {
    case 'number':
    case 'date':
      return Number(raw);
    case 'json':
    case 'file':
    case 'vector':
      return JSON.parse(raw);
    default:
      return raw;
  }
}

function displayCell(col: SchemaColumn, v: unknown): string {
  if (v === undefined || v === null) return '';
  if (col.kind === 'json' || col.kind === 'file' || col.kind === 'vector') return JSON.stringify(v);
  return String(v);
}

/** One editable cell — input flavour picked by column kind. */
function EditableCell({
  col,
  value,
  onSave,
}: {
  col: SchemaColumn;
  value: unknown;
  onSave: (v: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (col.kind === 'boolean') {
    return <Checkbox checked={Boolean(value)} onCheckedChange={(on) => onSave(Boolean(on))} />;
  }
  if (col.kind === 'select') {
    return (
      <select
        className="h-8 w-full rounded border border-transparent bg-transparent text-sm hover:border-input"
        value={String(value ?? '')}
        onChange={(e) => onSave(e.target.value || undefined)}
      >
        <option value="" />
        {(col.options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        className="block h-8 w-full truncate rounded border border-transparent px-1 text-left text-sm hover:border-input"
        onClick={() => {
          setDraft(displayCell(col, value));
          setEditing(true);
        }}
      >
        {displayCell(col, value) || <span className="text-muted-foreground">–</span>}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    try {
      const parsed = parseCell(col, draft);
      if (JSON.stringify(parsed) !== JSON.stringify(value)) onSave(parsed);
    } catch {
      // invalid JSON etc. — keep the old value, the cell just closes
    }
  };
  return (
    <Input
      autoFocus
      className="h-8 text-sm"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

export default function TableEditor() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [newRow, setNewRow] = useState<Record<string, string>>({});

  const { data: table } = useQuery({ queryKey: ['table', id], queryFn: () => tablesApi.get(id) });
  const { data: rowData } = useQuery({
    queryKey: ['table-rows', id, sort?.column, sort?.dir],
    queryFn: () =>
      tablesApi.rows(id, sort ? { sortColumn: sort.column, sortDir: sort.dir, limit: 200 } : { limit: 200 }),
    enabled: Boolean(table),
  });

  const dimensions = useMemo(
    () => (table?.schema.columns ?? []).filter((c) => c.role === 'dimension'),
    [table],
  );
  const measures = useMemo(
    () => (table?.schema.columns ?? []).filter((c) => c.role === 'measure'),
    [table],
  );

  const { data: summary } = useQuery({
    queryKey: ['table-agg', id, table?.rowCount, dimensions[0]?.key],
    queryFn: () =>
      tablesApi.aggregate(id, {
        dimensions: dimensions[0] ? [dimensions[0].key] : [],
        measures: measures.map((m) => ({ column: m.key, fn: 'sum' as const })),
      }),
    enabled: Boolean(table && measures.length > 0 && table.capabilities.aggregate),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['table-rows', id] });
    queryClient.invalidateQueries({ queryKey: ['table', id] });
    queryClient.invalidateQueries({ queryKey: ['table-agg', id] });
  };

  const upsert = useMutation({
    mutationFn: ({ rowId, values }: { rowId?: string; values: Record<string, unknown> }) =>
      tablesApi.upsertRow(id, rowId, values),
    onSuccess: invalidate,
    onError: (e) =>
      toast({ title: t('common.error'), description: e instanceof Error ? e.message : 'write failed', variant: 'destructive' }),
  });
  const removeRow = useMutation({
    mutationFn: (rowId: string) => tablesApi.deleteRow(id, rowId),
    onSuccess: invalidate,
  });

  const columnHelper = createColumnHelper<TableRow>();
  const columns = useMemo(
    () =>
      (table?.schema.columns ?? []).map((col) =>
        columnHelper.display({
          id: col.key,
          header: () => (
            <button
              type="button"
              className="flex items-center gap-1 font-medium"
              onClick={() =>
                setSort((s) =>
                  s?.column === col.key
                    ? s.dir === 'asc'
                      ? { column: col.key, dir: 'desc' }
                      : null
                    : { column: col.key, dir: 'asc' },
                )
              }
            >
              {col.label}
              {col.role !== 'attribute' && (
                <Badge variant="outline" className="text-[9px]">{t(`tables.roles.${col.role}`)}</Badge>
              )}
              {sort?.column === col.key &&
                (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
            </button>
          ),
          cell: (ctx) => (
            <EditableCell
              col={col}
              value={ctx.row.original.values[col.key]}
              onSave={(v) => upsert.mutate({ rowId: ctx.row.original.id, values: { [col.key]: v } })}
            />
          ),
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, sort, t],
  );

  const grid = useReactTable({
    data: rowData?.rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const addRow = () => {
    const values: Record<string, unknown> = {};
    try {
      for (const col of table?.schema.columns ?? []) {
        const raw = newRow[col.key];
        if (raw !== undefined && raw !== '') values[col.key] = parseCell(col, raw);
      }
    } catch {
      toast({ title: t('common.error'), description: t('tables.badJson'), variant: 'destructive' });
      return;
    }
    upsert.mutate({ values });
    setNewRow({});
  };

  if (!table) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="container mx-auto flex h-14 items-center gap-4 px-4">
          <Link to="/tables" className="flex items-center gap-2 text-foreground hover:text-primary">
            <ArrowLeft className="h-4 w-4" />
            {t('tables.title')}
          </Link>
          <h1 className="truncate text-lg font-semibold tracking-tight">{table.title}</h1>
          <span className="text-xs text-muted-foreground">
            {t(`tables.drivers.${table.driver}.name`)} · {t('tables.meta', { rows: table.rowCount, cols: table.schema.columns.length })}
          </span>
        </div>
      </header>

      <main className="container mx-auto space-y-4 px-4 py-6">
        {/* OLAP summary bar — the cube seed */}
        {summary && summary.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Sigma className="h-4 w-4" />
              {t('tables.summary')}
              {dimensions[0] && <Badge variant="secondary">{t('tables.byDimension', { dim: dimensions[0].label })}</Badge>}
            </div>
            <div className="flex flex-wrap gap-4 text-sm tabular-nums">
              {summary.map((g, i) => (
                <div key={i} className="rounded border border-border bg-background px-3 py-1.5">
                  {dimensions[0] && <span className="mr-2 font-medium">{String(g[dimensions[0].key] ?? '—')}</span>}
                  {measures.map((m) => (
                    <span key={m.key} className="mr-3 text-muted-foreground">
                      Σ {m.label}: <span className="text-foreground">{String(g[`sum_${m.key}`] ?? 0)}</span>
                      {m.unit ? ` ${m.unit}` : ''}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40">
              {grid.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} className="px-2 py-2 text-left">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                  <th className="w-10" />
                </tr>
              ))}
              {/* Add-row form row */}
              <tr className="border-b border-border bg-background">
                {(table.schema.columns ?? []).map((col) => (
                  <td key={col.key} className="px-2 py-1.5">
                    <Input
                      className="h-8 text-sm"
                      placeholder={col.required ? `${col.label} *` : col.label}
                      value={newRow[col.key] ?? ''}
                      onChange={(e) => setNewRow((prev) => ({ ...prev, [col.key]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && addRow()}
                    />
                  </td>
                ))}
                <td className="px-1">
                  <Button size="sm" variant="ghost" onClick={addRow} aria-label={t('tables.addRow')}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            </thead>
            <tbody>
              {grid.getRowModel().rows.map((row) => (
                <tr key={row.original.id} className="border-b border-border/50 hover:bg-muted/20">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-2 py-1">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                  <td className="px-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeRow.mutate(row.original.id)}
                      aria-label={t('common.delete')}
                    >
                      <Trash className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(rowData?.rows.length ?? 0) === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">{t('tables.noRows')}</p>
          )}
        </div>
      </main>
    </div>
  );
}
