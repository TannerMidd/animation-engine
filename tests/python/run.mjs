import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run the Python-side worker tests with the project venv.
 *
 * A tiny launcher rather than a shell one-liner because npm scripts run under
 * cmd.exe on Windows, where `.venv/Scripts/python` is not a command.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const python =
  process.env.ANIM_PYTHON ??
  (process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : 'python3');

const hermetic = [
  'worker_conditioning_test.py',
  'kokoro_mint_test.py',
  'whisper_worker_test.py',
  'prop_bake_test.py',
];
const tests = process.argv.includes('--hermetic') ? hermetic : [...hermetic, 'vc_register_test.py'];

for (const test of tests) {
  const result = spawnSync(python, [path.join(here, test)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.exit(0);
