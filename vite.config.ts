import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Main build: the side panel page and the background service worker.
 *
 * Both are ES modules in the packaged extension (the manifest declares
 * `"background": { "type": "module" }`), so Vite is free to split shared
 * code out into chunks here. The content script cannot do that, which is
 * why it gets its own config -- see vite.content.config.ts.
 *
 * Everything in public/ (manifest.json, icons) is copied to dist/ as-is.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome114', // minimum Chrome version for chrome.sidePanel
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        // Stable, predictable names so manifest.json can point at them.
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
});
