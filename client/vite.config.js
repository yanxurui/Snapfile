import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const distDir = path.resolve(rootDir, 'dist');

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
      '/signup': 'http://localhost:8080',
      '/login': 'http://localhost:8080',
      '/logout': 'http://localhost:8080',
      '/files': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      }
    }
  },
  build: {
    outDir: distDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(rootDir, 'index.html'),
        login: path.resolve(rootDir, 'login.html')
      }
    }
  }
});
