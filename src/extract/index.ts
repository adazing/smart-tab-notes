/**
 * Entry point for dist/extract.js.
 *
 * Built as a classic (IIFE) script by vite.extract.config.ts. Injecting it
 * defines a global `SmartTabNotesExtract` in the extension's isolated world;
 * shared/tabContext.ts then calls `SmartTabNotesExtract.extractPage()` in a
 * second chrome.scripting call to get the result back.
 */

export { extractPage } from './extractPage';
