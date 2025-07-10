import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { CheckCircle, Database, Loader2, AlertCircle } from 'lucide-react';
import { useDatabase } from '@/hooks/useDatabase';
import { useToast } from '@/hooks/use-toast';

export default function Setup() {
  const { isInitialized, error } = useDatabase();
  const [setupComplete, setSetupComplete] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [isInitializing, setIsInitializing] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const steps = [
    'Kontrola systému',
    'Inicializace databáze', 
    'Vytváření tabulek',
    'Vkládání ukázkových dat',
    'Dokončení instalace'
  ];

  useEffect(() => {
    if (isInitialized) {
      setSetupComplete(true);
      setCurrentStep(steps.length);
      setTimeout(() => {
        navigate('/');
      }, 2000);
    }
  }, [isInitialized, navigate]);

  const initializeDatabase = async () => {
    setIsInitializing(true);
    
    try {
      // Simulate setup steps
      for (let i = 1; i <= steps.length; i++) {
        setCurrentStep(i);
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      
      toast({
        title: "Úspěch",
        description: "Databáze byla úspěšně inicializována"
      });
      
    } catch (err) {
      toast({
        title: "Chyba", 
        description: "Nepodařilo se inicializovat databázi",
        variant: "destructive"
      });
    } finally {
      setIsInitializing(false);
    }
  };

  if (isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
              <div>
                <h3 className="font-semibold text-green-500">Aplikace je připravena!</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Přesměrováváme vás na úvodní stránku...
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

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
          {!isInitializing && currentStep === 0 && (
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
                  <span>{currentStep}/{steps.length}</span>
                </div>
                <Progress value={(currentStep / steps.length) * 100} />
              </div>

              <div className="space-y-2">
                {steps.map((stepName, index) => (
                  <div key={index} className="flex items-center gap-3 text-sm">
                    {index + 1 < currentStep ? (
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    ) : index + 1 === currentStep ? (
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border-2 border-muted" />
                    )}
                    <span className={index + 1 <= currentStep ? 'text-foreground' : 'text-muted-foreground'}>
                      {stepName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="w-4 h-4" />
                <span className="text-sm font-medium">Chyba připojení k serveru</span>
              </div>
              <p className="text-sm text-muted-foreground">{error.toString()}</p>
              <Button 
                onClick={() => window.location.reload()}
                variant="outline"
                size="sm"
                className="w-full"
              >
                Zkusit znovu
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}