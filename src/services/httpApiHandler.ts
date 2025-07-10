/**
 * HTTP API Handler
 * Překládá HTTP requesty na ApiRouter volání
 */

import { ApiRouter, ApiRequest, ApiResponse } from './apiRouter';
import { databaseService } from './database';

class HttpApiHandler {
  private apiRouter: ApiRouter;
  private isInitialized = false;

  constructor() {
    this.initializeRouter();
  }

  private async initializeRouter() {
    // Počkáme až bude databáze inicializovaná
    if (!this.isInitialized) {
      await databaseService.initialize();
      this.apiRouter = new ApiRouter(databaseService);
      this.isInitialized = true;
      this.setupHttpHandler();
    }
  }

  private setupHttpHandler() {
    // Vytvoříme HTTP handler pro Vite dev server
    const originalFetch = window.fetch;
    
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      
      // Zachytíme pouze API requesty
      if (url.startsWith('/api/')) {
        return this.handleApiRequest(url, init);
      }
      
      // Ostatní requesty pošleme dál
      return originalFetch(input, init);
    };
  }

  private async handleApiRequest(url: string, init?: RequestInit): Promise<Response> {
    if (!this.isInitialized) {
      await this.initializeRouter();
    }

    const urlObj = new URL(url, window.location.origin);
    const method = init?.method || 'GET';
    const path = urlObj.pathname;
    
    // Parsuj query parametry
    const query: any = {};
    urlObj.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Parsuj data (JSON body)
    let data: any = undefined;
    if (init?.body) {
      try {
        data = JSON.parse(init.body.toString());
      } catch (e) {
        data = init.body;
      }
    }

    // Vytvoř ApiRequest
    const apiRequest: ApiRequest = {
      type: 'API_REQUEST',
      method: method.toUpperCase(),
      path,
      data,
      query,
      requestId: `http_${Date.now()}_${Math.random()}`
    };

    // Zpracuj přes ApiRouter
    const response = await this.processApiRequest(apiRequest);

    // Vrať HTTP Response
    return new Response(JSON.stringify(response), {
      status: response.success ? 200 : (response.error === 'Not Found' ? 404 : 500),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  private async processApiRequest(req: ApiRequest): Promise<ApiResponse> {
    // Použijeme stejnou logiku jako ApiRouter
    const routeKey = this.getRouteKey(req.method, req.path);
    
    // Direktně zavoláme handler metody z ApiRouter
    try {
      const handlerMethod = this.getHandlerMethod(routeKey);
      if (handlerMethod) {
        return await handlerMethod(req);
      } else {
        return { success: false, error: 'Not Found' };
      }
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Server Error' 
      };
    }
  }

  private getRouteKey(method: string, path: string): string {
    // Kopie logiky z ApiRouter
    if (path.match(/^\/api\/metadata\/[^\/]+$/) && !path.includes('/domain/') && !path.includes('/search')) {
      return `${method}:/api/metadata/:id`;
    }
    if (path.match(/^\/api\/metadata\/domain\/.+$/)) {
      return `${method}:/api/metadata/domain/:domain`;
    }
    return `${method}:${path}`;
  }

  private getHandlerMethod(routeKey: string) {
    // Mapování route keys na handler metody
    const handlers: { [key: string]: (req: ApiRequest) => Promise<ApiResponse> | ApiResponse } = {
      'GET:/api/health': () => ({ success: true, data: { status: 'OK', timestamp: new Date().toISOString() } }),
      
      'GET:/api/taxonomy': () => {
        try {
          const options = this.generateTaxonomyOptions();
          return { success: true, data: options };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
      },

      'GET:/api/metadata': () => {
        try {
          const data = databaseService.getAllMetadataApi();
          return { success: true, data };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
      },

      'POST:/api/metadata': (req) => {
        try {
          const data = databaseService.saveMetadataApi(req.data);
          return { success: true, data };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
      },

      'GET:/api/metadata/domain/:domain': (req) => {
        try {
          const domain = decodeURIComponent(this.extractParam(req.path, '/api/metadata/domain/', ''));
          const data = databaseService.getMetadataByDomainApi(domain);
          return { success: true, data };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
      },

      'GET:/api/stats': () => {
        try {
          const allData = databaseService.getAllMetadataApi();
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
      }
    };

    return handlers[routeKey];
  }

  private extractParam(path: string, prefix: string, suffix: string): string {
    return path.replace(prefix, '').replace(suffix, '');
  }

  private generateTaxonomyOptions() {
    // Import taxonomy data
    const { taxonomyData } = require('@/game/data/taxonomy');
    
    const options: any[] = [];
    let categoryIndex = 1;

    Object.entries(taxonomyData).forEach(([categoryKey, category]: [string, any]) => {
      const categoryId = String(categoryIndex).padStart(2, '0');
      
      options.push({
        value: categoryId,
        label: `${categoryId} - ${category.name}`,
        level: 0
      });

      let subcategoryIndex = 1;
      Object.entries(category.subcategories).forEach(([subcatKey, subcat]: [string, any]) => {
        const subcatId = `${categoryId}.${String(subcategoryIndex).padStart(2, '0')}`;
        
        options.push({
          value: subcatId,
          label: `${subcatId} - ${subcat.name}`,
          level: 1
        });

        subcategoryIndex++;
      });

      categoryIndex++;
    });

    return options;
  }
}

// Vytvoř globální instanci
export const httpApiHandler = new HttpApiHandler();