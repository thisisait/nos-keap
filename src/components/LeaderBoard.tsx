
import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Trophy, Medal, Award, Star, TrendingUp } from 'lucide-react';

const LeaderBoard = () => {
  const topLearners = [
    {
      id: 1,
      name: "Anna Novotná",
      rank: 1,
      points: 2450,
      courses: 34,
      streak: 47,
      server: "IIAB-Prague-01",
      change: "+3"
    },
    {
      id: 2,
      name: "Petr Svoboda",
      rank: 2,
      points: 2389,
      courses: 31,
      streak: 23,
      server: "IIAB-Brno-02",
      change: "-1"
    },
    {
      id: 3,
      name: "Marie Dvořáková",
      rank: 3,
      points: 2234,
      courses: 29,
      streak: 34,
      server: "IIAB-Europe-Hub",
      change: "+2"
    },
    {
      id: 4,
      name: "Jan Procházka",
      rank: 4,
      points: 2156,
      courses: 28,
      streak: 19,
      server: "IIAB-Prague-01",
      change: "0"
    },
    {
      id: 5,
      name: "Eva Kratochvílová",
      rank: 5,
      points: 2098,
      courses: 26,
      streak: 41,
      server: "IIAB-Ostrava-01",
      change: "+1"
    },
    {
      id: 6,
      name: "Tomáš Černý",
      rank: 6,
      points: 1987,
      courses: 25,
      streak: 15,
      server: "IIAB-Vienna-01",
      change: "-3"
    }
  ];

  const achievements = [
    {
      title: "Průkopník",
      description: "Dokončil 50+ kurzů",
      icon: Trophy,
      count: 12,
      color: "text-yellow-400"
    },
    {
      title: "Vytrvalec",
      description: "30+ dní streak",
      icon: Medal,
      count: 23,
      color: "text-purple-400"
    },
    {
      title: "Mentor",
      description: "Pomohl 10+ uživatelům",
      icon: Star,
      count: 8,
      color: "text-blue-400"
    },
    {
      title: "Blockchain Guru",
      description: "Expert v SOL integraci",
      icon: Award,
      count: 5,
      color: "text-green-400"
    }
  ];

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Trophy className="h-5 w-5 text-yellow-400" />;
      case 2:
        return <Medal className="h-5 w-5 text-gray-300" />;
      case 3:
        return <Award className="h-5 w-5 text-amber-600" />;
      default:
        return <span className="text-gray-400 font-bold">#{rank}</span>;
    }
  };

  const getChangeColor = (change: string) => {
    if (change.startsWith('+')) return 'text-green-400';
    if (change.startsWith('-')) return 'text-red-400';
    return 'text-gray-400';
  };

  return (
    <div className="space-y-6">
      {/* Achievements Overview */}
      <Card className="bg-black/40 border-white/10 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Award className="h-5 w-5 text-yellow-400" />
            Úspěchy komunity
          </CardTitle>
          <CardDescription className="text-gray-300">
            Nejčastější úspěchy dosažené uživateli IIAB sítě
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {achievements.map((achievement, index) => {
              const IconComponent = achievement.icon;
              return (
                <div key={index} className="text-center p-4 bg-white/5 rounded-lg border border-white/10">
                  <IconComponent className={`h-8 w-8 ${achievement.color} mx-auto mb-2`} />
                  <div className="text-2xl font-bold text-white">{achievement.count}</div>
                  <div className="text-sm font-medium text-gray-300">{achievement.title}</div>
                  <div className="text-xs text-gray-400 mt-1">{achievement.description}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Top Learners */}
      <Card className="bg-black/40 border-white/10 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-purple-400" />
            Nejlepší studenti
          </CardTitle>
          <CardDescription className="text-gray-300">
            Žebříček nejaktivnějších studentů napříč celou IIAB sítí
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {topLearners.map((learner) => (
              <div key={learner.id} className="flex items-center justify-between p-4 bg-white/5 rounded-lg border border-white/10">
                <div className="flex items-center gap-4">
                  <div className="flex items-center justify-center w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-600 rounded-full">
                    {getRankIcon(learner.rank)}
                  </div>
                  
                  <Avatar className="h-10 w-10">
                    <AvatarFallback className="bg-gray-700 text-gray-300">
                      {learner.name.split(' ').map(n => n[0]).join('')}
                    </AvatarFallback>
                  </Avatar>
                  
                  <div>
                    <h3 className="font-semibold text-white">{learner.name}</h3>
                    <p className="text-sm text-gray-400">{learner.server}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-6 text-sm">
                  <div className="text-center">
                    <div className="text-white font-semibold">{learner.points}</div>
                    <div className="text-gray-400">bodů</div>
                  </div>
                  
                  <div className="text-center">
                    <div className="text-white font-semibold">{learner.courses}</div>
                    <div className="text-gray-400">kurzů</div>
                  </div>
                  
                  <div className="text-center">
                    <div className="text-white font-semibold">{learner.streak}</div>
                    <div className="text-gray-400">dní</div>
                  </div>
                  
                  <div className={`text-center ${getChangeColor(learner.change)}`}>
                    <div className="font-semibold">{learner.change}</div>
                    <div className="text-gray-400">změna</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Your Rank */}
      <Card className="bg-gradient-to-r from-purple-900/20 to-blue-900/20 border-purple-500/30 backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white mb-1">Vaše pozice</h3>
              <p className="text-gray-300">Momentálně se nacházíte na 47. místě ze 1,847 aktivních uživatelů</p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold text-purple-400">#47</div>
              <div className="text-sm text-gray-400">+5 pozic tento týden</div>
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-4 mt-6 pt-4 border-t border-white/10">
            <div className="text-center">
              <div className="text-xl font-bold text-white">156</div>
              <div className="text-sm text-gray-400">Získané body</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-white">23</div>
              <div className="text-sm text-gray-400">Dokončené kurzy</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-white">12</div>
              <div className="text-sm text-gray-400">Dní streak</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default LeaderBoard;
