import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { CheckCircle, Database, Loader2, AlertCircle } from 'lucide-react';
import { databaseService } from '@/services/database';
import { useToast } from '@/hooks/use-toast';

export default function Setup() {
  const [step, setStep] = useState(0);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  const steps = [
    'Kontrola systému',
    'Inicializace databáze',
    'Vytváření tabulek',
    'Vkládání ukázkových dat',
    'Dokončení instalace'
  ];

  useEffect(() => {
    // Check if database is already initialized
    const checkDatabase = async () => {
      try {
        await databaseService.initialize();
        // If successful, redirect to homepage
        navigate('/');
      } catch (err) {
        // Database needs setup
        console.log('Database needs setup');
      }
    };
    
    checkDatabase();
  }, [navigate]);

  const initializeDatabase = async () => {
    setIsInitializing(true);
    setError(null);

    try {
      // Step 1: System check
      setStep(1);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Step 2: Initialize database
      setStep(2);
      await databaseService.forceReinitialize();
      await new Promise(resolve => setTimeout(resolve, 800));

      // Step 3: Create tables
      setStep(3);
      await new Promise(resolve => setTimeout(resolve, 600));

      // Step 4: Insert sample data
      setStep(4);
      await new Promise(resolve => setTimeout(resolve, 400));

      // Step 5: Complete
      setStep(5);
      await new Promise(resolve => setTimeout(resolve, 300));

      toast({
        title: "Úspěch",
        description: "Databáze byla úspěšně inicializována"
      });

      // Redirect to homepage
      setTimeout(() => {
        navigate('/');
      }, 1000);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba při inicializaci databáze');
      toast({
        title: "Chyba",
        description: "Nepodařilo se inicializovat databázi",
        variant: "destructive"
      });
    } finally {
      setIsInitializing(false);
    }
  };

  const resetDatabase = async () => {
    if (confirm('Opravdu chcete resetovat databázi? Všechna data budou ztracena.')) {
      localStorage.removeItem('iiab-database');
      await initializeDatabase();
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center">
            <Database className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Instalace aplikace</CardTitle>
          <p className="text-muted-foreground mt-2">
            Připravujeme databázi pro vaši aplikaci
          </p>
        </CardHeader>
        
        <CardContent className="space-y-6">
          {!isInitializing && step === 0 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                Klikněte na tlačítko pro inicializaci databáze a začněte používat aplikaci.
              </p>
              <Button 
                onClick={initializeDatabase}
                className="w-full"
                size="lg"
              >
                Inicializovat databázi
              </Button>
            </div>
          )}

          {isInitializing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Postup instalace</span>
                  <span>{step}/{steps.length}</span>
                </div>
                <Progress value={(step / steps.length) * 100} />
              </div>

              <div className="space-y-2">
                {steps.map((stepName, index) => (
                  <div key={index} className="flex items-center gap-3 text-sm">
                    {index + 1 < step ? (
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    ) : index + 1 === step ? (
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border-2 border-muted" />
                    )}
                    <span className={index + 1 <= step ? 'text-foreground' : 'text-muted-foreground'}>
                      {stepName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="text-center space-y-4">
              <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
              <div>
                <h3 className="font-semibold text-green-500">Instalace dokončena!</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Přesměrováváme vás na úvodní stránku...
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="w-4 h-4" />
                <span className="text-sm font-medium">Chyba instalace</span>
              </div>
              <p className="text-sm text-muted-foreground">{error}</p>
              <div className="flex gap-2">
                <Button 
                  onClick={initializeDatabase}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                >
                  Zkusit znovu
                </Button>
                <Button 
                  onClick={resetDatabase}
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                >
                  Reset databáze
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}