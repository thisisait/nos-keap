import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';

export default defineConfig({
  srcDir: 'extension',
  publicDir: 'public',
  outDir: 'dist-extension',
  vite: () => ({
    plugins: [react()],
  }),
  alias: {
    '@': resolve('extension'),
  },
  manifest: ({ browser, manifestVersion }) => {
    const hosts = ['*://*/*', 'http://localhost:8080/*'];
    const basePerms = ['activeTab', 'contextMenus', 'storage'];
    const isMv2 = manifestVersion === 2;

    return {
      name: 'KEAP Companion',
      description: 'Explore and preserve knowledge from any page with KEAP.',
      permissions: isMv2 ? [...basePerms, ...hosts] : basePerms,
      host_permissions: isMv2 ? undefined : hosts,
      action: {
        default_title: 'Toggle KEAP bar',
      },
      browser_specific_settings:
        browser === 'firefox'
          ? { gecko: { id: 'keap-companion@pazny.eu' } }
          : undefined,
    };
  },
});
