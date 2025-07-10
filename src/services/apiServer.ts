/**
 * Real HTTP API Server for Vite middleware
 */

import { IncomingMessage, ServerResponse } from 'http';
import { databaseService } from './database';
// Import taxonomy data statically to avoid build issues
const taxonomyData = {
  "natural_sciences": {
    "name": "Natural Sciences",
    "subcategories": {
      "mathematics": { "name": "Mathematics" },
      "physics": { "name": "Physics" },
      "chemistry": { "name": "Chemistry" },
      "biology": { "name": "Biology" }
    }
  },
  "computer_science": {
    "name": "Computer Science", 
    "subcategories": {
      "programming": { "name": "Programming" },
      "algorithms": { "name": "Algorithms" },
      "databases": { "name": "Databases" }
    }
  }
};

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// Parse URL and query params
function parseUrl(req: IncomingMessage) {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  return {
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams.entries())
  };
}

// Parse JSON body
async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        resolve(undefined);
      }
    });
  });
}

// Send JSON response
function sendResponse(res: ServerResponse, status: number, data: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (res.statusCode === 200) {
    console.log(`API ${status}:`, data);
  }
  
  res.end(JSON.stringify(data));
}

// Generate taxonomy options
function generateTaxonomyOptions() {
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
    Object.entries(category.subcategories || {}).forEach(([subcatKey, subcat]: [string, any]) => {
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

// Extract param from URL path
function extractParam(path: string, prefix: string): string {
  return decodeURIComponent(path.replace(prefix, ''));
}

// Main API request handler
export async function handleApiRequest(req: IncomingMessage, res: ServerResponse) {
  const { pathname, query } = parseUrl(req);
  const method = req.method?.toUpperCase() || 'GET';
  
  console.log(`API Request: ${method} ${pathname}`);

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    sendResponse(res, 200, { success: true });
    return;
  }

  // Initialize database
  try {
    if (!(databaseService as any).db) {
      await databaseService.initialize();
    }
  } catch (error) {
    console.error('Database init error:', error);
    sendResponse(res, 500, { success: false, error: 'Database initialization failed' });
    return;
  }

  let response: ApiResponse;

  try {
    // Route handling
    if (method === 'GET' && pathname === '/api/health') {
      response = { success: true, data: { status: 'OK', timestamp: new Date().toISOString() } };
      
    } else if (method === 'GET' && pathname === '/api/taxonomy') {
      const options = generateTaxonomyOptions();
      response = { success: true, data: options };
      
    } else if (method === 'GET' && pathname === '/api/metadata') {
      const data = databaseService.getAllMetadataApi();
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname === '/api/metadata') {
      const body = await parseBody(req);
      if (!body) {
        response = { success: false, error: 'No data provided' };
      } else {
        const data = databaseService.saveMetadataApi(body);
        response = { success: true, data };
      }
      
    } else if (method === 'GET' && pathname.startsWith('/api/metadata/domain/')) {
      const domain = extractParam(pathname, '/api/metadata/domain/');
      const data = databaseService.getMetadataByDomainApi(domain);
      response = { success: true, data };
      
    } else if (method === 'GET' && pathname === '/api/metadata/search') {
      const searchQuery = query.q || '';
      const allData = databaseService.getAllMetadataApi();
      const filtered = allData.filter((item: any) => 
        item.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.description?.toLowerCase().includes(searchQuery.toLowerCase())
      );
      response = { success: true, data: filtered };
      
    } else if (method === 'GET' && pathname === '/api/stats') {
      const allData = databaseService.getAllMetadataApi();
      const domains = [...new Set(allData.map((item: any) => {
        const links = item.links || {};
        return links.domain || (links.url ? new URL(links.url).hostname : null);
      }).filter(Boolean))];
      
      response = {
        success: true,
        data: {
          totalMetadata: allData.length,
          domains,
          lastUpdate: new Date().toISOString()
        }
      };
      
    } else {
      response = { success: false, error: 'Not Found' };
    }

  } catch (error) {
    console.error('API Handler Error:', error);
    response = { 
      success: false, 
      error: error instanceof Error ? error.message : 'Server Error' 
    };
  }

  const status = response.success ? 200 : (response.error === 'Not Found' ? 404 : 500);
  sendResponse(res, status, response);
}