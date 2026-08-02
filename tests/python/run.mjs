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
const python = process.env.ANIM_PYTHON ?? path.join(root, '.venv', 'Scripts', 'python.exe');

const result = spawnSync(python, [path.join(here, 'worker_conditioning_test.py')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
