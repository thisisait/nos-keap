/**
 * API Service pro komunikaci s externí aplikací
 * Poskytuje endpointy pro companion panel
 */

export interface ApiTaxonomyMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  links: any;
  translations: any;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

class ApiService {
  private baseUrl: string = '';

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, ''); // Remove trailing slash
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          ...options.headers,
        },
        ...options,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      console.error('API Request failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // GET /api/metadata - Získat všechna metadata
  async getAllMetadata(): Promise<ApiResponse<ApiTaxonomyMetadata[]>> {
    return this.request<ApiTaxonomyMetadata[]>('/api/metadata');
  }

  // GET /api/metadata/:id - Získat metadata podle ID
  async getMetadata(id: string): Promise<ApiResponse<ApiTaxonomyMetadata>> {
    return this.request<ApiTaxonomyMetadata>(`/api/metadata/${id}`);
  }

  // GET /api/metadata/domain/:domain - Získat metadata pro doménu
  async getMetadataByDomain(domain: string): Promise<ApiResponse<ApiTaxonomyMetadata[]>> {
    return this.request<ApiTaxonomyMetadata[]>(`/api/metadata/domain/${encodeURIComponent(domain)}`);
  }

  // GET /api/metadata/search?q=query - Vyhledat metadata
  async searchMetadata(query: string): Promise<ApiResponse<ApiTaxonomyMetadata[]>> {
    return this.request<ApiTaxonomyMetadata[]>(`/api/metadata/search?q=${encodeURIComponent(query)}`);
  }

  // POST /api/metadata - Uložit nová metadata
  async saveMetadata(metadata: Omit<ApiTaxonomyMetadata, 'id' | 'createdAt' | 'updatedAt'>): Promise<ApiResponse<ApiTaxonomyMetadata>> {
    return this.request<ApiTaxonomyMetadata>('/api/metadata', {
      method: 'POST',
      body: JSON.stringify(metadata),
    });
  }

  // PUT /api/metadata/:id - Aktualizovat metadata
  async updateMetadata(id: string, metadata: Partial<ApiTaxonomyMetadata>): Promise<ApiResponse<ApiTaxonomyMetadata>> {
    return this.request<ApiTaxonomyMetadata>(`/api/metadata/${id}`, {
      method: 'PUT',
      body: JSON.stringify(metadata),
    });
  }

  // DELETE /api/metadata/:id - Smazat metadata
  async deleteMetadata(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(`/api/metadata/${id}`, {
      method: 'DELETE',
    });
  }

  // GET /api/health - Health check
  async healthCheck(): Promise<ApiResponse<{ status: string; timestamp: string }>> {
    return this.request<{ status: string; timestamp: string }>('/api/health');
  }

  // GET /api/stats - Statistiky
  async getStats(): Promise<ApiResponse<{ totalMetadata: number; domains: string[]; lastUpdate: string }>> {
    return this.request('/api/stats');
  }
}

export const apiService = new ApiService();