import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { APP_PORT } from "./src/config/port";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: APP_PORT,
    middlewareMode: false
  },
  plugins: [
    react(),
    mode === 'development' && componentTagger(),
    {
      name: 'api-middleware',
      configureServer(server: any) {
        server.middlewares.use('/api', async (req: any, res: any, next: any) => {
          try {
            // Import here to avoid circular deps
            const { handleApiRequest } = await import('./src/services/apiServer');
            await handleApiRequest(req, res);
          } catch (error) {
            console.error('API Error:', error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
          }
        });
      }
    }
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  
}));
