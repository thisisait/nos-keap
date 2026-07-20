/**
 * Admin › Relations (Track R3 stage 2) — the operator moderates the typed
 * cross-type relation graph. Two queues: PROPOSED relations (confirm → they join
 * the Vazby overlay + the brain endpoint; reject → they never render) and
 * PROPOSED relation TYPES (vocab growth: confirm a verb into the live palette
 * with a colour, or retire it). Same react-query + confirm/reject shape as the
 * Moderation and Topics panels. On confirm we also invalidate ['graph'] so the
 * explore overlay repaints.
 */
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Link2, Check, X, Palette } from 'lucide-react';
import { relationsApi, type AdminRelation, type AdminRelationType } from '@/services/api/relations';

export function RelationsPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-relations'],
    queryFn: () => relationsApi.list('proposed'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-relations'] });
    qc.invalidateQueries({ queryKey: ['graph'] });
  };

  const decideMut = useMutation({
    mutationFn: (v: { id: string; status: 'confirmed' | 'rejected' }) =>
      relationsApi.decide(v.id, v.status),
    onSuccess: invalidate,
  });

  const typeMut = useMutation({
    mutationFn: async (v: { type: string; decision: 'confirm' | 'reject' }) => {
      if (v.decision === 'confirm') await relationsApi.confirmType(v.type);
      else await relationsApi.rejectType(v.type);
    },
    onSuccess: invalidate,
  });

  const relations = (data?.relations ?? []).filter((r) => r.status === 'proposed');
  const proposedTypes = (data?.types ?? []).filter((rt) => rt.status === 'proposed');

  const verb = (type: string): string =>
    (data?.types ?? []).find((rt) => rt.type === type)?.label ?? type;

  return (
    <div className="space-y-6">
      {/* Proposed relation-type vocabulary growth */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            {t('admin.relations.vocabTitle')}
            <span className="text-sm font-normal text-muted-foreground">
              {t('admin.relations.pending', { count: proposedTypes.length })}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-4 text-center text-muted-foreground">{t('common.loading')}</p>
          ) : proposedTypes.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground">{t('admin.relations.vocabEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {proposedTypes.map((rt: AdminRelationType) => (
                <li
                  key={rt.type}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-sm">{rt.type}</span>
                    {rt.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{rt.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      onClick={() => typeMut.mutate({ type: rt.type, decision: 'confirm' })}
                      disabled={typeMut.isPending}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t('admin.relations.confirmType')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => typeMut.mutate({ type: rt.type, decision: 'reject' })}
                      disabled={typeMut.isPending}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      {t('admin.relations.reject')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Proposed relations queue */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            {t('admin.relations.title')}
            <span className="text-sm font-normal text-muted-foreground">
              {t('admin.relations.pending', { count: relations.length })}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-6 text-center text-muted-foreground">{t('common.loading')}</p>
          ) : relations.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">{t('admin.relations.empty')}</p>
          ) : (
            <ul className="space-y-4">
              {relations.map((r: AdminRelation) => (
                <li key={r.id} className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        <span className="text-muted-foreground">{r.fromLabel}</span>{' '}
                        <Badge variant="secondary" className="mx-1 font-mono text-[10px]">
                          {verb(r.type)}
                        </Badge>{' '}
                        <span className="text-muted-foreground">{r.toLabel}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('admin.relations.meta', {
                          source: r.source,
                          confidence:
                            r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '—',
                        })}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        onClick={() => decideMut.mutate({ id: r.id, status: 'confirmed' })}
                        disabled={decideMut.isPending}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" />
                        {t('admin.relations.confirm')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decideMut.mutate({ id: r.id, status: 'rejected' })}
                        disabled={decideMut.isPending}
                      >
                        <X className="mr-1 h-3.5 w-3.5" />
                        {t('admin.relations.reject')}
                      </Button>
                    </div>
                  </div>
                  {r.justification && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      <span className="font-medium">{t('admin.relations.justification')}:</span>{' '}
                      {r.justification}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
