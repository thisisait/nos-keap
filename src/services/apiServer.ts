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

    // Courses API
    } else if (method === 'GET' && pathname === '/api/courses') {
      const data = databaseService.getAllCourses();
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname.startsWith('/api/courses/') && pathname.includes('/progress')) {
      const courseId = parseInt(pathname.split('/')[3]);
      const body = await parseBody(req);
      if (!body || !courseId) {
        response = { success: false, error: 'Invalid course data' };
      } else {
        databaseService.updateCourseProgress(courseId, body.progress, body.completedChapters);
        response = { success: true };
      }

    // Completed Items API
    } else if (method === 'GET' && pathname === '/api/completed-items') {
      const data = databaseService.getCompletedItems();
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname.startsWith('/api/completed-items/')) {
      const itemId = extractParam(pathname, '/api/completed-items/');
      const completedItems = databaseService.getCompletedItems();
      if (completedItems.includes(itemId)) {
        databaseService.removeCompletedItem(itemId);
      } else {
        databaseService.addCompletedItem(itemId);
      }
      response = { success: true };

    // Taxonomy Metadata API
    } else if (method === 'GET' && pathname === '/api/taxonomy-metadata') {
      const data = databaseService.getTaxonomyMetadata();
      response = { success: true, data };
      
    } else if (method === 'GET' && pathname.startsWith('/api/taxonomy-metadata/')) {
      const id = extractParam(pathname, '/api/taxonomy-metadata/');
      const data = databaseService.getTaxonomyMetadata(id);
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname === '/api/taxonomy-metadata') {
      const body = await parseBody(req);
      if (!body) {
        response = { success: false, error: 'No data provided' };
      } else {
        databaseService.saveTaxonomyMetadata(body);
        response = { success: true };
      }
      
    } else if (method === 'DELETE' && pathname.startsWith('/api/taxonomy-metadata/')) {
      const id = extractParam(pathname, '/api/taxonomy-metadata/');
      databaseService.deleteTaxonomyMetadata(id);
      response = { success: true };

    // Homepage Tiles API
    } else if (method === 'GET' && pathname === '/api/homepage-tiles') {
      const data = databaseService.getHomepageTiles();
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname === '/api/homepage-tiles') {
      const body = await parseBody(req);
      if (!body) {
        response = { success: false, error: 'No data provided' };
      } else {
        databaseService.saveHomepageTiles(body);
        response = { success: true };
      }

    // Activity API
    } else if (method === 'GET' && pathname === '/api/activity') {
      const type = query.type;
      const limit = query.limit ? parseInt(query.limit) : 10;
      const data = databaseService.getRecentActivity(type, limit);
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname === '/api/activity') {
      const body = await parseBody(req);
      if (!body || !body.itemId || !body.itemType) {
        response = { success: false, error: 'Invalid activity data' };
      } else {
        databaseService.trackActivity(body.itemId, body.itemType);
        response = { success: true };
      }

    // App Metadata API
    } else if (method === 'GET' && pathname === '/api/app-metadata') {
      const data = databaseService.getAppMetadata();
      response = { success: true, data };

    // Settings API
    } else if (method === 'POST' && pathname === '/api/settings') {
      const body = await parseBody(req);
      if (!body || !body.key || body.value === undefined) {
        response = { success: false, error: 'Invalid settings data' };
      } else {
        databaseService.saveSetting(body.key, body.value);
        response = { success: true };
      }
      
    } else if (method === 'GET' && pathname.startsWith('/api/settings/')) {
      const key = extractParam(pathname, '/api/settings/');
      const data = databaseService.getSetting(key);
      response = { success: true, data };

    // Todos API
    } else if (method === 'GET' && pathname === '/api/todos') {
      const data = databaseService.getTodos();
      response = { success: true, data };
      
    } else if (method === 'POST' && pathname === '/api/todos') {
      const body = await parseBody(req);
      if (!body) {
        response = { success: false, error: 'No data provided' };
      } else {
        databaseService.saveTodo(body);
        response = { success: true };
      }
      
    } else if (method === 'DELETE' && pathname.startsWith('/api/todos/')) {
      const id = extractParam(pathname, '/api/todos/');
      databaseService.deleteTodo(id);
      response = { success: true };
      
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