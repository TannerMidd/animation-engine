import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
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

  get(p: string, h: Handler) {
    return this.add('GET', p, h);
  }
  post(p: string, h: Handler) {
    return this.add('POST', p, h);
  }
  put(p: string, h: Handler) {
    return this.add('PUT', p, h);
  }
  del(p: string, h: Handler) {
    return this.add('DELETE', p, h);
  }

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

export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_REQUEST_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
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
  constructor(
    readonly status: number,
    message: string,
  ) {
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

  const stream = async (start: number, end: number, status: 200 | 206): Promise<void> => {
    const length = end - start + 1;
    res.writeHead(status, {
      'content-type': type,
      'content-length': length,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(file, { start, end });
      input.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      input.pipe(res);
    });
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start: number;
      let end: number;
      if (!m[1] && m[2]) {
        const suffix = Number(m[2]);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      }
      if (
        stat.size === 0 ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= stat.size
      ) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}`, 'accept-ranges': 'bytes' });
        res.end();
        return;
      }
      await stream(start, end, 206);
      return;
    }
  }

  if (stat.size === 0) {
    res.writeHead(200, { 'content-type': type, 'content-length': 0, 'accept-ranges': 'bytes' });
    res.end();
    return;
  }
  await stream(0, stat.size - 1, 200);
}
