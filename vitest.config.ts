import { defineConfig } from 'vitest/config';

/**
 * Unit tests. Default environment is node; DOM tests opt in to jsdom with a
 * `// @vitest-environment jsdom` comment at the top of the file.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
