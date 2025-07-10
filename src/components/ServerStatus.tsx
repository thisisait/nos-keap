
import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Server, Wifi, Users, HardDrive, Globe, RefreshCw } from 'lucide-react';

const ServerStatus = () => {
  const servers = [
    {
      id: 1,
      name: "IIAB-Prague-01",
      location: "Praha, Česká republika",
      status: "online",
      users: 234,
      storage: 78,
      latency: 12,
      courses: 45,
      lastSync: "2 min"
    },
    {
      id: 2,
      name: "IIAB-Brno-02",
      location: "Brno, Česká republika",
      status: "online",
      users: 156,
      storage: 65,
      latency: 8,
      courses: 42,
      lastSync: "5 min"
    },
    {
      id: 3,
      name: "IIAB-Ostrava-01",
      location: "Ostrava, Česká republika",
      status: "maintenance",
      users: 0,
      storage: 45,
      latency: 0,
      courses: 38,
      lastSync: "2 hodin"
    },
    {
      id: 4,
      name: "IIAB-Europe-Hub",
      location: "Amsterdam, Nizozemsko",
      status: "online",
      users: 1247,
      storage: 89,
      latency: 45,
      courses: 67,
      lastSync: "1 min"
    },
    {
      id: 5,
      name: "IIAB-Vienna-01",
      location: "Vídeň, Rakousko",
      status: "offline",
      users: 0,
      storage: 23,
      latency: 0,
      courses: 35,
      lastSync: "6 hodin"
    }
  ];

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'maintenance':
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'offline':
        return 'bg-red-500/20 text-red-400 border-red-500/30';
      default:
        return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'maintenance':
        return 'Údržba';
      case 'offline':
        return 'Offline';
      default:
        return 'Neznámý';
    }
  };

  return (
    <div className="space-y-6">
      {/* Network Overview */}
      <Card className="bg-black/40 border-white/10 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Globe className="h-5 w-5 text-blue-400" />
            Přehled IIAB sítě
          </CardTitle>
          <CardDescription className="text-gray-300">
            Stav všech dostupných serverů v decentralizované síti
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-4 bg-green-900/20 rounded-lg">
              <div className="text-2xl font-bold text-green-400">12</div>
              <div className="text-sm text-gray-400">Online servery</div>
            </div>
            <div className="text-center p-4 bg-blue-900/20 rounded-lg">
              <div className="text-2xl font-bold text-blue-400">1,847</div>
              <div className="text-sm text-gray-400">Aktivní uživatelé</div>
            </div>
            <div className="text-center p-4 bg-purple-900/20 rounded-lg">
              <div className="text-2xl font-bold text-purple-400">67</div>
              <div className="text-sm text-gray-400">Dostupné kurzy</div>
            </div>
            <div className="text-center p-4 bg-yellow-900/20 rounded-lg">
              <div className="text-2xl font-bold text-yellow-400">23ms</div>
              <div className="text-sm text-gray-400">Průměrná latence</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Server List */}
      <div className="space-y-4">
        {servers.map((server) => (
          <Card key={server.id} className="bg-black/40 border-white/10 backdrop-blur-sm">
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3 flex-1">
                  <div className="p-2 bg-blue-900/30 rounded-lg">
                    <Server className="h-6 w-6 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">{server.name}</h3>
                    <p className="text-gray-400 text-sm">{server.location}</p>
                  </div>
                </div>
                
                <Badge className={getStatusColor(server.status)}>
                  {getStatusText(server.status)}
                </Badge>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-gray-400" />
                  <span className="text-gray-300">{server.users} uživatelů</span>
                </div>
                
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 text-gray-400" />
                  <span className="text-gray-300">{server.storage}% úložiště</span>
                </div>
                
                <div className="flex items-center gap-2">
                  <Wifi className="h-4 w-4 text-gray-400" />
                  <span className="text-gray-300">{server.latency}ms latence</span>
                </div>
                
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-gray-400" />
                  <span className="text-gray-300">{server.courses} kurzů</span>
                </div>
                
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-gray-400" />
                  <span className="text-gray-300">Sync: {server.lastSync}</span>
                </div>
              </div>

              {server.status === 'online' && (
                <div className="mt-4 pt-4 border-t border-white/10">
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
                  >
                    Připojit k serveru
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Connection Info */}
      <Card className="bg-blue-900/20 border-blue-500/30 backdrop-blur-sm">
        <CardContent className="p-6">
          <h3 className="text-blue-400 font-semibold mb-2">Aktuální připojení</h3>
          <p className="text-gray-300 mb-2">Připojeno k: <span className="text-white font-medium">IIAB-Prague-01</span></p>
          <p className="text-sm text-gray-400">
            Váš pokrok je automaticky synchronizován mezi všemi dostupnými servery v síti.
            Při přepnutí na jiný server bude váš pokrok zachován díky blockchain technologii.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default ServerStatus;
