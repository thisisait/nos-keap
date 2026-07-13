import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// SPA-only config. The API is a real standalone process (server/index.ts) —
// in dev it runs on :8081 (`npm run dev` starts both) and Vite proxies /api
// to it; in production the compiled server serves the built SPA itself.
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    proxy: {
      "/api": {
        target: "http://localhost:8081",
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
