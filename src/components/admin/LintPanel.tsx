/**
 * Admin › Lint — the cortex health report (server/lint.ts findings).
 * Read view + on-demand run; verdicts normally arrive from the librarian
 * agent, but an admin can rule here too (fine / duplicate / contradiction).
 */
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Stethoscope, Play } from 'lucide-react';
import { apiFetch } from '@/services/api/client';

interface LintFinding {
  id: string;
  checkId: string;
  severity: string;
  message: string;
  data?: { verdict?: { verdict: string; by: string } };
  firstSeen: number;
}

interface LintReport {
  open: number;
  counts: Record<string, number>;
  findings: LintFinding[];
}

const SEV_VARIANT: Record<string, 'destructive' | 'default' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
  info: 'outline',
};

export function LintPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: report, isLoading } = useQuery({
    queryKey: ['lint'],
    queryFn: () => apiFetch<LintReport>('/api/lint'),
  });

  const run = useMutation({
    mutationFn: () => apiFetch<LintReport>('/api/lint/run', { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['lint'], data),
  });

  const verdict = useMutation({
    mutationFn: (v: { findingId: string; verdict: string }) =>
      apiFetch('/api/lint/verdict', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lint'] }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="h-5 w-5" />
          {t('admin.lint.title')}
          {report && (
            <span className="text-sm font-normal text-muted-foreground">
              {t('admin.lint.summary', { open: report.open })}
            </span>
          )}
        </CardTitle>
        <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
          <Play className="mr-1 h-3.5 w-3.5" />
          {run.isPending ? t('admin.lint.running') : t('admin.lint.run')}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-6 text-center text-muted-foreground">{t('common.loading')}</p>
        ) : !report?.findings.length ? (
          <p className="py-6 text-center text-muted-foreground">{t('admin.lint.clean')}</p>
        ) : (
          <ul className="divide-y">
            {report.findings.map((f) => (
              <li key={f.id} className="flex items-start gap-3 py-2 text-sm">
                <Badge variant={SEV_VARIANT[f.severity] ?? 'outline'} className="mt-0.5 shrink-0">
                  {f.severity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p>{f.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {f.checkId}
                    {f.data?.verdict && (
                      <> · {t('admin.lint.judged', { verdict: f.data.verdict.verdict, by: f.data.verdict.by })}</>
                    )}
                  </p>
                </div>
                {(f.checkId === 'overlap-review' || f.checkId === 'near-duplicate') && !f.data?.verdict && (
                  <span className="flex shrink-0 gap-1">
                    {(['fine', 'duplicate', 'contradiction'] as const).map((v) => (
                      <Button
                        key={v}
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-[10px]"
                        onClick={() => verdict.mutate({ findingId: f.id, verdict: v })}
                      >
                        {t(`admin.lint.verdict.${v}`)}
                      </Button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
