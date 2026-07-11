/**
 * Admin › Moderation — the operator's FINAL WORD on what enters the curated
 * corpus. Lists promotion proposals (librarian- or human-authored object
 * drafts built from queue datapoints) with the draft preview, rationale and
 * advisory votes; Approve materializes the object (full provenance in its
 * frontmatter), Reject closes the proposal. Under the future democratic/MMO
 * policy this same list is decided by quorum instead of one admin.
 */
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Gavel, Check, X } from 'lucide-react';
import { apiFetch } from '@/services/api/client';

interface Promotion {
  id: string;
  captureId: string;
  proposedBy: string;
  rationale?: string;
  object: { type: string; title: string; body?: string; resource?: string; tags?: string[] };
  status: string;
  votes: Array<{ by: string; value: number }>;
  decidedBy?: string;
  objectId?: string;
}

interface PromotionList {
  policy: { policy: string; quorum: number };
  items: Promotion[];
}

export function ModerationPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['promotions'],
    queryFn: () => apiFetch<PromotionList>('/api/promotions'),
  });

  const decideMut = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) =>
      apiFetch(`/api/promotions/${v.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: v.decision }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotions'] }),
  });

  const open = (data?.items ?? []).filter((p) => p.status === 'proposed');
  const decided = (data?.items ?? []).filter((p) => p.status !== 'proposed').slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gavel className="h-5 w-5" />
          {t('admin.moderation.title')}
          {data && (
            <span className="text-sm font-normal text-muted-foreground">
              {t('admin.moderation.policy', { policy: data.policy.policy })} ·{' '}
              {t('admin.moderation.pending', { count: open.length })}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <p className="py-6 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : open.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">{t('admin.moderation.empty')}</p>
        ) : (
          <ul className="space-y-4">
            {open.map((p) => {
              const net = p.votes.reduce((s, v) => s + v.value, 0);
              return (
                <li key={p.id} className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {p.object.title}{' '}
                        <Badge variant="secondary" className="ml-1">{p.object.type}</Badge>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('admin.moderation.proposedBy', { by: p.proposedBy })}
                        {net !== 0 && <> · {t('admin.moderation.votes', { net: net > 0 ? `+${net}` : net })}</>}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        onClick={() => decideMut.mutate({ id: p.id, decision: 'approve' })}
                        disabled={decideMut.isPending}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" />
                        {t('admin.moderation.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decideMut.mutate({ id: p.id, decision: 'reject' })}
                        disabled={decideMut.isPending}
                      >
                        <X className="mr-1 h-3.5 w-3.5" />
                        {t('admin.moderation.reject')}
                      </Button>
                    </div>
                  </div>
                  {p.rationale && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      <span className="font-medium">{t('admin.moderation.rationale')}:</span> {p.rationale}
                    </p>
                  )}
                  {p.object.body && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                      {p.object.body}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {decided.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('admin.moderation.recentlyDecided')}
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {decided.map((p) => (
                <li key={p.id}>
                  <Badge variant={p.status === 'approved' ? 'default' : 'outline'} className="mr-1 text-[10px]">
                    {p.status}
                  </Badge>
                  {p.object.title} · {p.decidedBy}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
