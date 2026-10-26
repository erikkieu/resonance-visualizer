import { defineConfig } from 'vite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Exposes the optional photo plates found in /public/textures as a virtual
 * module, so Scene 4 can discover them without probing URLs (which would log
 * 404s in the console when no plate exists).
 */
function texturePlates() {
  const id = 'virtual:texture-plates';
  const resolved = '\0' + id;
  const dir = fileURLToPath(new URL('./public/textures', import.meta.url));
  return {
    name: 'texture-plates',
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(source) {
      if (source !== resolved) return;
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f));
      } catch {
        /* folder missing: no plates */
      }
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

// GitHub Pages serves the site from https://<user>.github.io/<repo>/
const PAGES_BASE = '/resonance-visualizer/';

export default defineConfig(({ command, isPreview }) => ({
  // builds (and `vite preview` of them) use the Pages sub-path;
  // the dev server stays at http://localhost:5173/
  base: command === 'build' || isPreview ? PAGES_BASE : '/',
  plugins: [texturePlates()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
}));
