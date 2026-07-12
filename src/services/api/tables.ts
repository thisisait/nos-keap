import { apiFetch } from './client';
import type {
  TableInfo,
  TableRow,
  TableDriver,
  TableCapabilities,
  CreateTableRequest,
  AggregateQuery,
} from '../../../shared/contracts/table';

export interface DriverInfo {
  driver: TableDriver;
  available: boolean;
  capabilities: TableCapabilities;
}

export const tablesApi = {
  list: () => apiFetch<TableInfo[]>('/api/tables'),
  drivers: () => apiFetch<DriverInfo[]>('/api/tables/drivers'),
  get: (id: string) => apiFetch<TableInfo>(`/api/tables/${encodeURIComponent(id)}`),
  create: (req: CreateTableRequest) =>
    apiFetch<TableInfo>('/api/tables', { method: 'POST', body: JSON.stringify(req) }),
  remove: (id: string) => apiFetch<void>(`/api/tables/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  rows: (id: string, opts: { sortColumn?: string; sortDir?: 'asc' | 'desc'; cursor?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.sortColumn) {
      p.set('sort_column', opts.sortColumn);
      p.set('sort_dir', opts.sortDir ?? 'asc');
    }
    if (opts.cursor) p.set('cursor', opts.cursor);
    if (opts.limit) p.set('limit', String(opts.limit));
    const qs = p.toString();
    return apiFetch<{ rows: TableRow[]; nextCursor?: string }>(
      `/api/tables/${encodeURIComponent(id)}/rows${qs ? `?${qs}` : ''}`,
    );
  },
  upsertRow: (id: string, rowId: string | undefined, values: Record<string, unknown>) =>
    apiFetch<TableRow>(`/api/tables/${encodeURIComponent(id)}/rows`, {
      method: 'POST',
      body: JSON.stringify({ id: rowId, values }),
    }),
  deleteRow: (id: string, rowId: string) =>
    apiFetch<void>(`/api/tables/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}`, {
      method: 'DELETE',
    }),
  history: (id: string, rowId: string) =>
    apiFetch<Array<{ op: string; values: Record<string, unknown> | null; actor: string; at: number }>>(
      `/api/tables/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}/history`,
    ),
  aggregate: (id: string, q: Partial<AggregateQuery> & Pick<AggregateQuery, 'measures'>) =>
    apiFetch<Array<Record<string, unknown>>>(`/api/tables/${encodeURIComponent(id)}/aggregate`, {
      method: 'POST',
      body: JSON.stringify(q),
    }),
};
