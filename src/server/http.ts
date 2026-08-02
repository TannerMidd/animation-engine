import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A very small routing layer.
 *
 * No framework: this server has perhaps twenty routes, all local, single-user.
 * A dependency here would cost more in maintenance than it saves in code.
 */

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  del(p: string, h: Handler) { return this.add('DELETE', p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const pat = route.parts[i]!;
        const got = parts[i]!;
        if (pat.startsWith(':')) params[pat.slice(1)] = decodeURIComponent(got);
        else if (pat !== got) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function text(res: ServerResponse, body: string, status = 200, type = 'text/plain'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Send a file, with Range support so the browser can scrub video and audio. */
export async function sendFile(res: ServerResponse, file: string, req?: IncomingMessage): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new HttpError(404, `not found: ${path.basename(file)}`);
  }

  const type = mimeFor(file);
  const range = req?.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      const handle = await fs.open(file, 'r');
      try {
        const length = end - start + 1;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, start);
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
          'content-length': length,
        });
        res.end(buf);
        return;
      } finally {
        await handle.close();
      }
    }
  }

  const data = await fs.readFile(file);
  res.writeHead(200, {
    'content-type': type,
    'content-length': data.length,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  res.end(data);
}
