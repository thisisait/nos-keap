import { Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

const NotFound = () => {
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    console.error('404: non-existent route:', location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold tracking-tight text-foreground">404</h1>
        <p className="text-lg text-muted-foreground">{t('notFound.message')}</p>
        <Button asChild variant="outline">
          <Link to="/">{t('notFound.backHome')}</Link>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;
