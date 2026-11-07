import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Plugin, defineConfig } from 'vite';

/**
 * ONNX Runtime Web (automatic segmentation) is loaded at run time from ./ort/ – copied as-is
 * from node_modules so its WebAssembly glue can find the .wasm and its worker threads.
 */
const ORT_DIR = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url));
const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

function ortRuntime(): Plugin {
  return {
    name: 'ort-runtime',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/ort\/([\w.-]+?)(\?.*)?$/);
        if (!m || !ORT_FILES.includes(m[1])) return next();
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(ORT_DIR + m[1]));
      });
    },
    generateBundle() {
      for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(ORT_DIR + f) });
    },
  };
}

// Relative base so the built app works from any sub-path (e.g. GitHub Pages)
// or straight from the file system. Two pages: the desktop app and the
// simplified phone version (index.html redirects phones to it).
export default defineConfig({
  base: './',
  plugins: [ortRuntime()],
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
