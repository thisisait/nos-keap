import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FilePenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/services/api/client';

interface ComposeDraftData {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: number;
}

export default function ComposeDraft() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [draft, setDraft] = useState<ComposeDraftData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ComposeDraftData>(`/api/extension/drafts/${encodeURIComponent(id)}`)
      .then(setDraft)
      .catch((reason: Error) => setError(reason.message));
  }, [id]);

  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t('common.home')}
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FilePenLine className="h-5 w-5" />
              {t('composeDraft.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {draft ? (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{t(`composeDraft.kind.${draft.kind}`, { defaultValue: draft.kind })}</span>
                  <span className="text-muted-foreground">
                    {t('composeDraft.expires', { date: new Date(draft.expiresAt * 1000).toLocaleString() })}
                  </span>
                </div>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">
                  {JSON.stringify(draft.payload, null, 2)}
                </pre>
                <p className="text-sm text-muted-foreground">{t('composeDraft.foundation')}</p>
              </>
            ) : error ? (
              <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
            ) : (
              <p className="text-muted-foreground">{t('common.loading')}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
