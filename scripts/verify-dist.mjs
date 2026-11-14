/**
 * Sanity-checks dist/ after a build.
 *
 * Chrome reports a manifest that points at a missing file as a vague load
 * failure, which is a slow thing to debug. This catches it at build time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const problems = [];

function requireFile(relativePath, why) {
  if (!existsSync(resolve(DIST, relativePath))) {
    problems.push(`${why} is missing from dist/: ${relativePath}`);
  }
}

const manifestPath = resolve(DIST, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('dist/manifest.json is missing. Did the main Vite build run?');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

requireFile(manifest.background.service_worker, 'background.service_worker');
requireFile(manifest.side_panel.default_path, 'side_panel.default_path');

for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) requireFile(file, 'content script');
  for (const file of script.css ?? []) requireFile(file, 'content script stylesheet');
}

for (const icon of Object.values(manifest.icons ?? {})) requireFile(icon, 'icon');
for (const icon of Object.values(manifest.action?.default_icon ?? {})) {
  requireFile(icon, 'action icon');
}

// Injected on demand by shared/tabContext.ts, so the manifest does not list it.
const INJECTED_SCRIPTS = ['extract.js'];
for (const file of INJECTED_SCRIPTS) requireFile(file, 'injected script');

// Content scripts and injected scripts run as classic scripts, so they must
// not have been split into ES-module chunks by the bundler.
const classicScripts = [
  ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
  ...INJECTED_SCRIPTS,
];
for (const file of classicScripts) {
  const full = resolve(DIST, file);
  if (!existsSync(full)) continue;
  const source = readFileSync(full, 'utf8');
  if (/(^|\n)\s*import\s/.test(source) || /(^|\n)\s*export\s/.test(source)) {
    problems.push(
      `${file} contains import/export. Content and injected scripts cannot be ES modules -- ` +
        'build them in iife format (see vite.content.config.ts).',
    );
  }
}

if (problems.length > 0) {
  console.error('\n[smart-tab-notes] dist/ is not loadable:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log('[smart-tab-notes] dist/ looks loadable.');
