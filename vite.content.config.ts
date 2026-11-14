import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Content script build.
 *
 * Content scripts are not ES modules: Chrome injects them as classic
 * scripts, so they cannot `import` anything at runtime. This build uses
 * IIFE format with a single entry so that everything the content script
 * touches (including src/shared) is inlined into one dist/content.js.
 *
 * It runs after the main build with `emptyOutDir: false` so it does not
 * wipe dist/.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome114',
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'SmartTabNotesContent',
      fileName: () => 'content.js',
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
});
