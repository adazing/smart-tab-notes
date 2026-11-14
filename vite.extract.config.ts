import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Page extractor build (dist/extract.js).
 *
 * Injected on demand with chrome.scripting.executeScript({ files }), which,
 * like a content script, runs a classic script: no runtime imports. IIFE
 * format inlines Mozilla Readability and src/shared into one file and
 * exposes the exports on a global `SmartTabNotesExtract`.
 *
 * Kept out of the content script so Readability (~40 KB) only loads into a
 * tab when its text is actually requested.
 *
 * Runs after the main build with `emptyOutDir: false` so it does not wipe dist/.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome114',
    lib: {
      entry: resolve(__dirname, 'src/extract/index.ts'),
      formats: ['iife'],
      name: 'SmartTabNotesExtract',
      fileName: () => 'extract.js',
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
});
