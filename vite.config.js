import { defineConfig } from 'vite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Exposes the files found in a /public folder as a virtual module, so the app
 * can discover them without probing URLs (which would log 404s in the console
 * when a file is missing):
 *   virtual:texture-plates  optional photo plates in /public/textures (Scene 3's reference)
 *   virtual:music-library   the pieces in /public/Music and their analyses in /public/analysis
 */
function folderListing(name, id, folders) {
  const resolved = '\0' + id;
  const dirs = folders.map(([key, folder, pattern]) => [key, fileURLToPath(new URL(`./public/${folder}`, import.meta.url)), pattern]);
  const list = (dir, pattern) => {
    try {
      // names stay as on disk (macOS may decompose "ä"); src/pieces.js matches them normalised
      return fs.readdirSync(dir).filter((f) => pattern.test(f));
    } catch {
      return []; // folder missing
    }
  };
  return {
    name,
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(source) {
      if (source !== resolved) return;
      if (dirs.length === 1) return `export default ${JSON.stringify(list(dirs[0][1], dirs[0][2]))};`;
      return `export default ${JSON.stringify(Object.fromEntries(dirs.map(([key, dir, pattern]) => [key, list(dir, pattern)])))};`;
    },
    // pick up files added or removed while the dev server runs
    configureServer(server) {
      for (const [, dir] of dirs) server.watcher.add(dir);
      const refresh = (file) => {
        if (!dirs.some(([, dir]) => file.startsWith(dir))) return;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
  };
}

// GitHub Pages serves the site from https://<user>.github.io/<repo>/
const PAGES_BASE = '/resonance-visualizer/';

export default defineConfig(({ command, isPreview }) => ({
  // builds (and `vite preview` of them) use the Pages sub-path;
  // the dev server stays at http://localhost:5173/
  base: command === 'build' || isPreview ? PAGES_BASE : '/',
  plugins: [
    folderListing('texture-plates', 'virtual:texture-plates', [['plates', 'textures', /\.(jpe?g|png|webp|avif)$/i]]),
    folderListing('music-library', 'virtual:music-library', [
      ['music', 'Music', /\.(mp3|wav|flac|ogg|oga|m4a|aac|webm)$/i],
      ['analysis', 'analysis', /\.json$/i],
    ]),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
}));
