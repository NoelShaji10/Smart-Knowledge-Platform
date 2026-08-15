import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@knowledge/auth': path.resolve(__dirname, './packages/auth/src/index.ts'),
      '@knowledge/database': path.resolve(__dirname, './packages/database/src/index.ts'),
      '@knowledge/config': path.resolve(__dirname, './packages/config/src/index.ts'),
      '@knowledge/types': path.resolve(__dirname, './packages/types/src/index.ts'),
      '@knowledge/redis': path.resolve(__dirname, './packages/redis/src/index.ts'),
      '@knowledge/storage': path.resolve(__dirname, './packages/storage/src/index.ts'),
      '@knowledge/jobs': path.resolve(__dirname, './packages/jobs/src/index.ts'),
      '@knowledge/ai-gateway': path.resolve(__dirname, './packages/ai-gateway/src/index.ts'),
      '@knowledge/vector-store': path.resolve(__dirname, './packages/vector-store/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
