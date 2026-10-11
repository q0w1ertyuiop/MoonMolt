import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = spawnSync('moon', ['build', '--target', 'js', '--release', '--warn-list', '-79'], { cwd: root, stdio: 'inherit', shell: false });
if (run.error) throw run.error;
if (run.status) process.exit(run.status);
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
copyFileSync(new URL('../_build/js/release/build/node/node.js', import.meta.url), new URL('../dist/engine.mjs', import.meta.url));
