
import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BookOpen, Clock, Award, PlayCircle } from 'lucide-react';
import { useDatabase } from '@/hooks/useDatabase';

const ProgressTracker: React.FC = () => {
  const { isInitialized, getCourses, getUserStats } = useDatabase();
  const [courses, setCourses] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});

  useEffect(() => {
    if (isInitialized) {
      setCourses(getCourses());
      setStats(getUserStats());
    }
  }, [isInitialized, getCourses, getUserStats]);

  return (
    <div className="space-y-6">
      {/* Overall Progress */}
      <Card className="bg-black/40 border-white/10 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Award className="h-5 w-5 text-yellow-400" />
            Celkový pokrok učení
          </CardTitle>
          <CardDescription className="text-gray-300">
            Váš pokrok napříč všemi dostupnými kurzy v IIAB síti
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-300">Celkový pokrok</span>
              <span className="text-white font-bold">{stats.totalProgress || 0}%</span>
            </div>
            <Progress value={stats.totalProgress || 0} className="h-3" />
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              <div className="text-center p-4 bg-purple-900/20 rounded-lg">
                <div className="text-2xl font-bold text-purple-400">{stats.completedCourses || 0}</div>
                <div className="text-sm text-gray-400">Dokončené kurzy</div>
              </div>
              <div className="text-center p-4 bg-blue-900/20 rounded-lg">
                <div className="text-2xl font-bold text-blue-400">{stats.totalPoints || 0}</div>
                <div className="text-sm text-gray-400">Získané body</div>
              </div>
              <div className="text-center p-4 bg-green-900/20 rounded-lg">
                <div className="text-2xl font-bold text-green-400">{stats.totalHours || 0}h</div>
                <div className="text-sm text-gray-400">Čas učení</div>
              </div>
              <div className="text-center p-4 bg-yellow-900/20 rounded-lg">
                <div className="text-2xl font-bold text-yellow-400">{stats.completedCourses || 0}</div>
                <div className="text-sm text-gray-400">Certifikáty</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Course List */}
      <div className="grid gap-4">
        {courses.map((course) => (
          <Card key={course.id} className="bg-black/40 border-white/10 backdrop-blur-sm">
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-white">{course.title}</h3>
                    {course.completed && (
                      <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                        Dokončeno
                      </Badge>
                    )}
                  </div>
                  <p className="text-gray-400 mb-3">Kategorie: {course.category}</p>
                  
                  <div className="flex items-center gap-4 text-sm text-gray-400 mb-4">
                    <div className="flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      {course.duration}
                    </div>
                    <div className="flex items-center gap-1">
                      <BookOpen className="h-4 w-4" />
                      {course.completedChapters}/{course.chapters} kapitol
                    </div>
                    <div className="flex items-center gap-1">
                      <Award className="h-4 w-4" />
                      {course.points} bodů
                    </div>
                  </div>
                </div>
                
                <Button 
                  className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                >
                  <PlayCircle className="h-4 w-4 mr-2" />
                  {course.completed ? 'Opakovat' : 'Pokračovat'}
                </Button>
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-400">Pokrok</span>
                  <span className="text-sm text-white font-medium">{course.progress}%</span>
                </div>
                <Progress value={course.progress} className="h-2" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="bg-green-900/20 border-green-500/30 backdrop-blur-sm">
        <CardContent className="p-6 text-center">
          <p className="text-green-400 mb-2">
            Vaše data jsou automaticky ukládána lokálně v browseru
          </p>
          <p className="text-sm text-gray-400">
            Pokrok je zachován mezi relacemi pomocí lokální SQLite databáze
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default ProgressTracker;
