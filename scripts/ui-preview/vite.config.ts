// Dev-only Vite server for the browser UI preview harness.
//   1. Export a fixture: MTS_FIXTURE_IN=<theme.mtz> MTS_FIXTURE_OUT=src-tauri/target/ui-fixture \
//        cargo test --manifest-path src-tauri/Cargo.toml --lib export_ui_fixture -- --ignored
//   2. npx vite --config scripts/ui-preview/vite.config.ts
//   3. Open http://localhost:5199/scripts/ui-preview/index.html (?project=0, ?phone=0)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = process.env.MTS_FIXTURE ?? path.join(root, 'src-tauri', 'target', 'ui-fixture');

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', xml: 'text/xml' };

function fixtureServer(): Plugin {
  let index: Record<string, string> | null = null;
  return {
    name: 'mts-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url.startsWith('/__fixture/')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(readFileSync(path.join(fixture, url.slice('/__fixture/'.length).split('?')[0])));
          return;
        }
        if (url.startsWith('/__res/main/') || url.startsWith('/__res/ref/')) {
          index ??= JSON.parse(readFileSync(path.join(fixture, 'index.json'), 'utf8'));
          const key = decodeURIComponent(url.slice(url.indexOf('/', '/__res/'.length) + 1).split('?')[0]);
          const file = index![key];
          if (!file) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const ext = key.split('.').pop()?.toLowerCase() ?? '';
          res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
          res.end(readFileSync(path.join(fixture, 'files', file)));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), fixtureServer()],
  server: { port: 5199, strictPort: true },
});
