import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'app',
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
  server: {
    proxy: { '/api': 'https://raxi-catalog.todominate-ai.workers.dev', '/media': 'https://raxi-catalog.todominate-ai.workers.dev' },
  },
});
