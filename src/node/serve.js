// ============================================================
// node/serve.js — `sloptimize serve`: a dev server for any app
// ============================================================
// The ingest routes (node/ingest.js) on a bare http server, plus, when
// asked, the app's own static files with the `js-profiling` document policy
// on HTML — so `sloptimize ask cpuprofile` can sample the page. One process,
// no dependencies: `sloptimize serve --static dist --port 4390`.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createIngest } from './ingest.js';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.map': 'application/json', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2' };

export function serve(opts = {}) {
  const ingest = createIngest({ dir: opts.dir, repoDir: opts.repoDir });
  const root = opts.static ? resolve(opts.static) : null;
  const mw = ingest.middleware();
  const srv = createServer((req, res) => {
    mw(req, res, () => {
      if (!root) { res.writeHead(404); res.end('sloptimize serve: no --static root'); return; }
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let p = join(root, rel === '/' ? 'index.html' : rel);
      if (!p.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
      if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
      if (!existsSync(p) || !statSync(p).isFile()) {
        // SPA fallback: an extension-less route is the app's own router.
        if (extname(rel) === '' && existsSync(join(root, 'index.html'))) p = join(root, 'index.html');
        else { res.writeHead(404); res.end('Not found'); return; }
      }
      const type = MIME[extname(p)] ?? 'application/octet-stream';
      const headers = { 'content-type': type, 'cache-control': 'no-cache' };
      if (type === 'text/html') headers['document-policy'] = 'js-profiling';
      res.writeHead(200, headers);
      res.end(readFileSync(p));
    });
  });
  return new Promise((ok) => srv.listen(opts.port ?? 4390, opts.host ?? '127.0.0.1', () => ok({ server: srv, port: srv.address().port, dir: ingest.dir, static: root })));
}
