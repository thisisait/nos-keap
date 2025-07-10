/**
 * API Router Service
 * Poskytuje skutečné API endpointy pro companion panel
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ApiRequest {
  type: string;
  method: string;
  path: string;
  data?: any;
  params?: any;
  query?: any;
  requestId: string;
}

export class ApiRouter {
  private handlers: Map<string, (req: ApiRequest) => Promise<ApiResponse> | ApiResponse> = new Map();
  private database: any;

  constructor(database: any) {
    this.database = database;
    this.setupRoutes();
    this.startListening();
  }

  private setupRoutes() {
    // GET /api/metadata
    this.handlers.set('GET:/api/metadata', () => {
      try {
        const data = this.database.getAllMetadataApi();
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // GET /api/metadata/:id
    this.handlers.set('GET:/api/metadata/:id', (req) => {
      try {
        const id = this.extractParam(req.path, '/api/metadata/', '');
        const allData = this.database.getAllMetadataApi();
        const data = allData.find((item: any) => item.id === id);
        
        if (!data) {
          return { success: false, error: 'Metadata not found' };
        }
        
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // GET /api/metadata/domain/:domain
    this.handlers.set('GET:/api/metadata/domain/:domain', (req) => {
      try {
        const domain = decodeURIComponent(this.extractParam(req.path, '/api/metadata/domain/', ''));
        const data = this.database.getMetadataByDomainApi(domain);
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // GET /api/metadata/search
    this.handlers.set('GET:/api/metadata/search', (req) => {
      try {
        const searchQuery = req.query?.q || '';
        const allData = this.database.getAllMetadataApi();
        const filtered = allData.filter((item: any) => 
          item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          item.description.toLowerCase().includes(searchQuery.toLowerCase())
        );
        return { success: true, data: filtered };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // POST /api/metadata
    this.handlers.set('POST:/api/metadata', (req) => {
      try {
        const data = this.database.saveMetadataApi(req.data);
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // PUT /api/metadata/:id
    this.handlers.set('PUT:/api/metadata/:id', (req) => {
      try {
        const id = this.extractParam(req.path, '/api/metadata/', '');
        const allData = this.database.getAllMetadataApi();
        const existing = allData.find((item: any) => item.id === id);
        
        if (!existing) {
          return { success: false, error: 'Metadata not found' };
        }

        const updated = {
          id,
          name: req.data.name || existing.name,
          description: req.data.description || existing.description,
          icon: req.data.icon || existing.icon,
          links: JSON.stringify(req.data.links || existing.links),
          translations: JSON.stringify(req.data.translations || existing.translations)
        };
        
        this.database.saveTaxonomyMetadata(updated);
        
        return {
          success: true,
          data: {
            ...updated,
            links: req.data.links || existing.links,
            translations: req.data.translations || existing.translations,
            updatedAt: new Date().toISOString()
          }
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // DELETE /api/metadata/:id
    this.handlers.set('DELETE:/api/metadata/:id', (req) => {
      try {
        const id = this.extractParam(req.path, '/api/metadata/', '');
        const allData = this.database.getAllMetadataApi();
        const existing = allData.find((item: any) => item.id === id);
        
        if (!existing) {
          return { success: false, error: 'Metadata not found' };
        }
        
        this.database.deleteTaxonomyMetadata(id);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // GET /api/health
    this.handlers.set('GET:/api/health', () => {
      return { success: true, data: { status: 'OK', timestamp: new Date().toISOString() } };
    });

    // GET /api/stats
    this.handlers.set('GET:/api/stats', () => {
      try {
        const allData = this.database.getAllMetadataApi();
        const domains = [...new Set(allData.map((item: any) => {
          const links = item.links || {};
          return links.domain || (links.url ? new URL(links.url).hostname : null);
        }).filter(Boolean))];
        
        return {
          success: true,
          data: {
            totalMetadata: allData.length,
            domains,
            lastUpdate: new Date().toISOString()
          }
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });
  }

  private extractParam(path: string, prefix: string, suffix: string): string {
    return path.replace(prefix, '').replace(suffix, '');
  }

  private startListening() {
    const handleApiMessage = async (event: MessageEvent) => {
      if (!event.data.type?.startsWith('API_')) return;

      const { type, method, path, data, query, requestId } = event.data as ApiRequest;
      
      if (type !== 'API_REQUEST') return;

      const routeKey = this.getRouteKey(method, path);
      const handler = this.handlers.get(routeKey);
      
      let response: ApiResponse;
      
      if (handler) {
        try {
          response = await handler({ type, method, path, data, query, requestId, params: {} });
        } catch (error) {
          response = { 
            success: false, 
            error: error instanceof Error ? error.message : 'Server Error' 
          };
        }
      } else {
        response = { success: false, error: 'Not Found' };
      }

      // Send response back to companion
      window.postMessage({
        type: 'API_RESPONSE',
        requestId,
        data: response
      }, '*');
    };

    window.addEventListener('message', handleApiMessage);
  }

  private getRouteKey(method: string, path: string): string {
    // Convert dynamic routes to static keys
    if (path.match(/^\/api\/metadata\/[^\/]+$/) && !path.includes('/domain/') && !path.includes('/search')) {
      return `${method}:/api/metadata/:id`;
    }
    if (path.match(/^\/api\/metadata\/domain\/.+$/)) {
      return `${method}:/api/metadata/domain/:domain`;
    }
    return `${method}:${path}`;
  }
}