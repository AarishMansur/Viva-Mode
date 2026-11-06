// scripts/smoke.mjs
// Launches the built app with VIVA_SMOKE=1 and forwards the harness exit code.
//
//   npm run smoke
//
// The harness clicks through the real practice flow and writes screenshots and
// a result.json into ./smoke.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');

const child = spawn(electron, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VIVA_SMOKE: '1' },
});

child.on('exit', (code, signal) => {
  if (signal) console.error(`[smoke] electron exited on ${signal}`);
  process.exit(code ?? 1);
});
