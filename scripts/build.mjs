/**
 * Runs both Vite builds in the right order.
 *
 *   node scripts/build.mjs           one-off build into dist/
 *   node scripts/build.mjs --watch   rebuild on change (for `npm run dev`)
 *
 * The main build must go first: it empties dist/ and copies public/.
 * The content-script build then adds dist/content.js alongside it.
 */
import { build } from 'vite';

const watch = process.argv.includes('--watch');

const configs = [
  { configFile: 'vite.config.ts', label: 'sidepanel + background' },
  { configFile: 'vite.content.config.ts', label: 'content script' },
  { configFile: 'vite.extract.config.ts', label: 'page extractor' },
];

for (const { configFile, label } of configs) {
  process.stdout.write(`\n[smart-tab-notes] building ${label}...\n`);
  await build({
    configFile,
    build: watch ? { watch: {} } : {},
  });
}

if (watch) {
  process.stdout.write('\n[smart-tab-notes] watching for changes. Reload the extension in chrome://extensions after each rebuild.\n');
} else {
  process.stdout.write('\n[smart-tab-notes] done. Load the dist/ folder as an unpacked extension.\n');
}
