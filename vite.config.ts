import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Relative base so the built app works from any sub-path (e.g. GitHub Pages)
// or straight from the file system. Two pages: the desktop app and the
// simplified phone version (index.html redirects phones to it).
export default defineConfig({
  base: './',
  // decode workers lazy-load their WASM codecs (needs ES-module workers)
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        mobile: fileURLToPath(new URL('./mobile.html', import.meta.url)),
      },
    },
  },
});
