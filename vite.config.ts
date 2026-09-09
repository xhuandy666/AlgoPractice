import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  resolve: { alias: [{ find: /^\.\/dompurify\/dompurify\.js$/, replacement: fileURLToPath(new URL('./src/renderer/monaco-dompurify.ts', import.meta.url)) }] },
  build: { outDir: 'dist/renderer', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
});
