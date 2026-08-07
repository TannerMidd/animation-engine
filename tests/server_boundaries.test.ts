import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server/index.ts';
import { HttpError, readBody, sendFile } from '../src/server/http.ts';
import { AnimationDocument } from '../src/schema/animation.ts';
import { DialogueDocument } from '../src/schema/dialogue.ts';
import { ShotList } from '../src/schema/script.ts';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function jsonRequest(pathname: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('server trust boundaries', () => {
  it('rejects encoded separators and malformed route parameters', async () => {
    expect((await fetch(`${baseUrl}/api/scenes/%2Foutside`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/scenes/%E0%A4%A`)).status).toBe(400);
  });

  it('contains static-file traversal inside the UI build', async () => {
    const response = await fetch(`${baseUrl}/..%2Fpackage.json`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('animation-engine');
  });

  it('rejects authored documents whose scene identity disagrees with the URL', async () => {
    const shots = ShotList.parse({
      scene: 'other-scene',
      cast: [{ id: 'actor', rig: 'actor', mark: 'CENTER' }],
      beats: [{ kind: 'pause', ms: 100 }],
    });
    const dialogue = DialogueDocument.parse({ schemaVersion: 1, scene: 'other-scene' });
    const animation = AnimationDocument.parse({
      schemaVersion: 1,
      scene: 'other-scene',
      layers: [{ id: 'generated', name: 'Generated', ownership: 'generated' }],
    });

    expect((await jsonRequest('/api/scenes/url-scene/shotlist', 'PUT', { shots })).status).toBe(400);
    expect((await jsonRequest('/api/scenes/url-scene/dialogue', 'PUT', { document: dialogue })).status).toBe(
      400,
    );
    expect(
      (await jsonRequest('/api/scenes/url-scene/animation', 'PUT', { document: animation })).status,
    ).toBe(400);
  });

  it('bounds request bodies before buffering the whole payload', async () => {
    const request = Readable.from([Buffer.alloc(3), Buffer.alloc(3)]) as unknown as http.IncomingMessage;
    await expect(readBody(request, 5)).rejects.toMatchObject({ status: 413 });
  });
});

describe('HTTP byte ranges', () => {
  it('streams valid ranges and returns 416 for impossible ranges', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'animation-engine-http-'));
    const file = path.join(temp, 'sample.bin');
    await fs.writeFile(file, Buffer.from('0123456789'));
    const rangeServer = http.createServer((req, res) => {
      void sendFile(res, file, req).catch((error: unknown) => {
        res.statusCode = error instanceof HttpError ? error.status : 500;
        res.end();
      });
    });
    try {
      await new Promise<void>((resolve) => rangeServer.listen(0, '127.0.0.1', resolve));
      const address = rangeServer.address();
      if (!address || typeof address === 'string') throw new Error('range server did not bind');
      const url = `http://127.0.0.1:${address.port}`;
      const partial = await fetch(url, { headers: { range: 'bytes=2-5' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await partial.text()).toBe('2345');

      const suffix = await fetch(url, { headers: { range: 'bytes=-3' } });
      expect(suffix.status).toBe(206);
      expect(await suffix.text()).toBe('789');

      const invalid = await fetch(url, { headers: { range: 'bytes=99-100' } });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('content-range')).toBe('bytes */10');
    } finally {
      await new Promise<void>((resolve) => rangeServer.close(() => resolve()));
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
