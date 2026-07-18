import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server tests run in Node; client tests opt into jsdom per-file.
    environment: 'node',
    include: ['server/**/*.test.js', 'src/**/*.test.js'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'server/**/*.js'],
      exclude: [
        '**/__tests__/**',
        'src/assets/**',
        '**/*.config.js',
        'server/node_modules/**',
        '.qodo/**',
      ],
      reporter: ['text', 'html'],
    },
  },
});
