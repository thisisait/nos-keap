import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useDatabase } from '../hooks/useDatabase';
import { apiService, ApiTaxonomyMetadata } from '../services/api';
import { useToast } from "@/hooks/use-toast";

/**
 * API Router Component
 * Simuluje Express.js API server běžící na portu 8080
 */
const Api = () => {
  const { getTaxonomyMetadata, saveTaxonomyMetadata, deleteTaxonomyMetadata } = useDatabase();
  const { toast } = useToast();
  const [isListening, setIsListening] = useState(false);

  // API Handler functions
  const handleGetAllMetadata = () => {
    const metadata = getTaxonomyMetadata() as any[];
    return {
      success: true,
      data: metadata.map(item => ({
        ...item,
        links: typeof item.links === 'string' ? JSON.parse(item.links || '{}') : item.links,
        translations: typeof item.translations === 'string' ? JSON.parse(item.translations || '{}') : item.translations,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }))
    };
  };

  const handleGetMetadata = (id: string) => {
    const metadata = getTaxonomyMetadata(id) as any;
    if (!metadata) {
      return { success: false, error: 'Metadata not found' };
    }
    return {
      success: true,
      data: {
        ...metadata,
        links: typeof metadata.links === 'string' ? JSON.parse(metadata.links || '{}') : metadata.links,
        translations: typeof metadata.translations === 'string' ? JSON.parse(metadata.translations || '{}') : metadata.translations,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };
  };

  const handleGetMetadataByDomain = (domain: string) => {
    const allMetadata = getTaxonomyMetadata() as any[];
    const filtered = allMetadata.filter(item => {
      const links = typeof item.links === 'string' ? JSON.parse(item.links || '{}') : item.links;
      return links.domain === domain || (links.url && new URL(links.url).hostname === domain);
    });
    
    return {
      success: true,
      data: filtered.map(item => ({
        ...item,
        links: typeof item.links === 'string' ? JSON.parse(item.links || '{}') : item.links,
        translations: typeof item.translations === 'string' ? JSON.parse(item.translations || '{}') : item.translations,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }))
    };
  };

  const handleSaveMetadata = (metadata: Omit<ApiTaxonomyMetadata, 'id' | 'createdAt' | 'updatedAt'>) => {
    const id = `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newMetadata = {
      id,
      name: metadata.name,
      description: metadata.description,
      icon: metadata.icon,
      links: JSON.stringify(metadata.links || {}),
      translations: JSON.stringify(metadata.translations || {})
    };
    
    saveTaxonomyMetadata(newMetadata);
    
    return {
      success: true,
      data: {
        ...newMetadata,
        links: metadata.links || {},
        translations: metadata.translations || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };
  };

  const handleUpdateMetadata = (id: string, updates: Partial<ApiTaxonomyMetadata>) => {
    const existing = getTaxonomyMetadata(id) as any;
    if (!existing) {
      return { success: false, error: 'Metadata not found' };
    }

    const updated = {
      ...existing,
      ...updates,
      links: JSON.stringify(updates.links || existing.links),
      translations: JSON.stringify(updates.translations || existing.translations)
    };
    
    saveTaxonomyMetadata(updated);
    
    return {
      success: true,
      data: {
        ...updated,
        links: updates.links || JSON.parse(existing.links || '{}'),
        translations: updates.translations || JSON.parse(existing.translations || '{}'),
        updatedAt: new Date().toISOString()
      }
    };
  };

  const handleDeleteMetadata = (id: string) => {
    const existing = getTaxonomyMetadata(id);
    if (!existing) {
      return { success: false, error: 'Metadata not found' };
    }
    
    deleteTaxonomyMetadata(id);
    return { success: true };
  };

  // Mock API message handler
  useEffect(() => {
    const handleApiMessage = (event: MessageEvent) => {
      if (!event.data.type?.startsWith('API_')) return;

      const { type, method, path, data, params, query } = event.data;
      let response;

      try {
        switch (type) {
          case 'API_REQUEST':
            if (method === 'GET' && path === '/api/metadata') {
              response = handleGetAllMetadata();
            } else if (method === 'GET' && path.startsWith('/api/metadata/') && !path.includes('/domain/')) {
              const id = path.split('/').pop();
              response = handleGetMetadata(id);
            } else if (method === 'GET' && path.includes('/api/metadata/domain/')) {
              const domain = decodeURIComponent(path.split('/').pop() || '');
              response = handleGetMetadataByDomain(domain);
            } else if (method === 'GET' && path === '/api/metadata/search') {
              const searchQuery = query?.q || '';
              const allMetadata = handleGetAllMetadata().data;
              const filtered = allMetadata.filter((item: any) => 
                item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                item.description.toLowerCase().includes(searchQuery.toLowerCase())
              );
              response = { success: true, data: filtered };
            } else if (method === 'POST' && path === '/api/metadata') {
              response = handleSaveMetadata(data);
            } else if (method === 'PUT' && path.startsWith('/api/metadata/')) {
              const id = path.split('/').pop();
              response = handleUpdateMetadata(id, data);
            } else if (method === 'DELETE' && path.startsWith('/api/metadata/')) {
              const id = path.split('/').pop();
              response = handleDeleteMetadata(id);
            } else if (method === 'GET' && path === '/api/health') {
              response = { success: true, data: { status: 'OK', timestamp: new Date().toISOString() } };
            } else if (method === 'GET' && path === '/api/stats') {
              const allMetadata = handleGetAllMetadata().data;
              const domains = [...new Set(allMetadata.map((item: any) => {
                const links = item.links || {};
                return links.domain || (links.url ? new URL(links.url).hostname : null);
              }).filter(Boolean))];
              
              response = {
                success: true,
                data: {
                  totalMetadata: allMetadata.length,
                  domains,
                  lastUpdate: new Date().toISOString()
                }
              };
            } else {
              response = { success: false, error: 'Not Found' };
            }
            break;
          default:
            response = { success: false, error: 'Unknown API type' };
        }
      } catch (error) {
        response = { 
          success: false, 
          error: error instanceof Error ? error.message : 'Server Error' 
        };
      }

      // Send response back to companion
      window.postMessage({
        type: 'API_RESPONSE',
        requestId: event.data.requestId,
        data: response
      }, '*');
    };

    window.addEventListener('message', handleApiMessage);
    setIsListening(true);

    return () => {
      window.removeEventListener('message', handleApiMessage);
      setIsListening(false);
    };
  }, [getTaxonomyMetadata, saveTaxonomyMetadata, deleteTaxonomyMetadata]);

  const stats = (() => {
    const allMetadata = handleGetAllMetadata().data;
    const domains = [...new Set(allMetadata.map((item: any) => {
      const links = item.links || {};
      return links.domain || (links.url ? new URL(links.url).hostname : null);
    }).filter(Boolean))];
    
    return {
      totalMetadata: allMetadata.length,
      domains: domains.length,
      lastUpdate: new Date().toISOString()
    };
  })();

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">API Server</h1>
            <p className="text-muted-foreground mt-1">
              Mock API server pro companion panel komunikaci
            </p>
          </div>
          <Badge variant={isListening ? "default" : "secondary"}>
            {isListening ? "🟢 Listening" : "🔴 Offline"}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total Metadata</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalMetadata}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Domains</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.domains}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">OK</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>API Endpoints</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Badge variant="outline" className="mr-2">GET</Badge>
              <code>/api/metadata</code> - Získat všechna metadata
            </div>
            <div className="space-y-2">
              <Badge variant="outline" className="mr-2">GET</Badge>
              <code>/api/metadata/:id</code> - Získat metadata podle ID
            </div>
            <div className="space-y-2">
              <Badge variant="outline" className="mr-2">GET</Badge>
              <code>/api/metadata/domain/:domain</code> - Metadata pro doménu
            </div>
            <div className="space-y-2">
              <Badge variant="outline" className="mr-2">GET</Badge>
              <code>/api/metadata/search?q=query</code> - Vyhledat metadata
            </div>
            <div className="space-y-2">
              <Badge variant="default" className="mr-2">POST</Badge>
              <code>/api/metadata</code> - Uložit nová metadata
            </div>
            <div className="space-y-2">
              <Badge variant="default" className="mr-2">PUT</Badge>
              <code>/api/metadata/:id</code> - Aktualizovat metadata
            </div>
            <div className="space-y-2">
              <Badge variant="destructive" className="mr-2">DELETE</Badge>
              <code>/api/metadata/:id</code> - Smazat metadata
            </div>
            <div className="space-y-2">
              <Badge variant="outline" className="mr-2">GET</Badge>
              <code>/api/health</code> - Health check
            </div>
            <div className="space-y-2">
              <Badge variant="outline" className="mr-2">GET</Badge>
              <code>/api/stats</code> - Statistiky
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Api;