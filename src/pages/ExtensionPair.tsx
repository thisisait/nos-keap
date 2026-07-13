import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Link2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/services/api/client';

interface Pairing {
  id: string;
  clientName: string;
  scopes: string[];
  status: string;
  expiresAt: number;
}

export default function ExtensionPair() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const code = params.get('code')?.trim().toUpperCase() ?? '';
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!code) {
      setError(t('extensionPair.invalid'));
      return;
    }
    apiFetch<Pairing>(`/api/extension/pairings/${encodeURIComponent(code)}`)
      .then(setPairing)
      .catch((reason: Error) => setError(reason.message));
  }, [code, t]);

  const approve = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/extension/pairings/${encodeURIComponent(code)}/approve`, { method: 'POST' });
      setApproved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            {t('extensionPair.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {approved ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
              <p className="font-medium">{t('extensionPair.approved')}</p>
              <p className="text-sm text-muted-foreground">{t('extensionPair.return')}</p>
            </div>
          ) : pairing ? (
            <>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground">{t('extensionPair.client')}</p>
                <p className="font-semibold">{pairing.clientName}</p>
                <p className="mt-3 text-sm text-muted-foreground">{t('extensionPair.code')}</p>
                <p className="font-mono text-lg tracking-widest">{code}</p>
              </div>
              <div>
                <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck className="h-4 w-4" />
                  {t('extensionPair.permissions')}
                </p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {pairing.scopes.map((scope) => (
                    <li key={scope}>• {t(`extensionPair.scope.${scope}`, { defaultValue: scope })}</li>
                  ))}
                </ul>
              </div>
              <Button className="w-full" onClick={approve} disabled={submitting || pairing.status !== 'pending'}>
                {submitting ? t('common.loading') : t('extensionPair.approve')}
              </Button>
            </>
          ) : !error ? (
            <p className="text-center text-muted-foreground">{t('common.loading')}</p>
          ) : null}
          {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
          <Button asChild variant="ghost" className="w-full">
            <Link to="/">{t('common.home')}</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
