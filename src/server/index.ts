import http from 'node:http';
import path from 'node:path';
import { ROOT } from '../core/paths.ts';
import { Router, json, text, sendFile, HttpError, type Ctx } from './http.ts';
import { getPreview, probeEngines } from './state.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerShowRoutes } from './routes/show.ts';
import { registerSceneRoutes } from './routes/scenes.ts';
import { registerCastRoutes } from './routes/cast.ts';
import { registerVoiceRoutes } from './routes/voices.ts';
import { registerSetRoutes } from './routes/sets.ts';
import { registerPropRoutes } from './routes/props.ts';
import { exists } from '../pipeline/scene.ts';
import { initShow } from '../show/store.ts';

/**
 * The engine server: route assembly and the HTTP shell.
 *
 * The routes themselves live under routes/, one file per surface, against the
 * same tiny Router. Shared state — previews, engine probes, the production
 * snapshot helpers — lives in state.ts. This file only wires them together
 * and serves the built UI.
 */

const UI_DIST = path.join(ROOT, 'ui', 'dist');

const router = new Router();
registerSystemRoutes(router);
registerShowRoutes(router);
registerSceneRoutes(router);
registerCastRoutes(router);
registerVoiceRoutes(router);
registerSetRoutes(router);
registerPropRoutes(router);

// --- preview pages ---

router.get('/preview/:id', ({ res, params }) => {
  const html = getPreview(params['id']!);
  if (!html) throw new HttpError(404, 'preview expired — rebuild it');
  text(res, html, 200, 'text/html');
});

// --- server ---------------------------------------------------------------

async function serveUi(ctx: Ctx): Promise<void> {
  const pathname = new URL(ctx.req.url ?? '/', 'http://localhost').pathname;
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Contain path traversal: everything must resolve inside the build folder.
  const file = path.resolve(UI_DIST, rel);
  if (!file.startsWith(path.resolve(UI_DIST))) throw new HttpError(403, 'forbidden');

  if (await exists(file)) return sendFile(ctx.res, file, ctx.req);

  const index = path.join(UI_DIST, 'index.html');
  if (await exists(index)) return sendFile(ctx.res, index, ctx.req);

  text(
    ctx.res,
    'The UI has not been built yet.\n\nRun:  npm run ui:build\nThen reload this page.\n',
    503,
  );
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = { req, res, params: {}, query: url.searchParams };

    try {
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (match) {
        ctx.params = match.params;
        await match.handler(ctx);
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/')) {
        throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
      }
      await serveUi(ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(`[server] ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) json(res, { error: message }, status);
      else res.end();
    }
  });
}

export async function startServer(port: number): Promise<{ port: number; close: () => void }> {
  // The active identity governs style, prompts and directing defaults for every
  // request, so it loads before the first one can arrive.
  await initShow();

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      probeEngines();
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
