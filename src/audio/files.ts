import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
export { atomicWriteFile } from '../core/files.ts';

export async function fileSha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function bodySha256(body: Buffer | string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}
