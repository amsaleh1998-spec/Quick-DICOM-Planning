import { defineConfig } from 'vite';

// Relative base so the built app works from any sub-path (e.g. GitHub Pages)
// or straight from the file system.
export default defineConfig({
  base: './',
});
