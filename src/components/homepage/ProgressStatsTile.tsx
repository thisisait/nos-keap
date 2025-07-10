import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TrendingUp, Target, Clock, Award } from 'lucide-react';

interface ProgressStatsTileProps {
  title?: string;
  config?: any;
}

export const ProgressStatsTile: React.FC<ProgressStatsTileProps> = ({ 
  title = 'Statistiky pokroku',
  config = {}
}) => {
  // Mock data - would come from database
  const stats = {
    totalProgress: 68,
    completedAreas: 12,
    totalAreas: 25,
    studyHours: 47,
    streak: 5
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="w-4 h-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Celkový pokrok</span>
            <span className="font-medium">{stats.totalProgress}%</span>
          </div>
          <Progress value={stats.totalProgress} className="h-2" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <Target className="w-3 h-3 text-muted-foreground" />
            <div className="text-xs">
              <div className="font-medium">{stats.completedAreas}/{stats.totalAreas}</div>
              <div className="text-muted-foreground">oblastí</div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <div className="text-xs">
              <div className="font-medium">{stats.studyHours}h</div>
              <div className="text-muted-foreground">studia</div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center p-2 bg-muted/30 rounded-md">
          <Award className="w-4 h-4 text-game-success mr-2" />
          <span className="text-sm font-medium">{stats.streak} dní v řadě</span>
        </div>
      </CardContent>
    </Card>
  );
};