// Packaging non-disclosure assertions: the packed root artifact and the
// materialized host dependency must contain only the allowlisted surface.
// Usage: node scripts/check-package-artifact.mjs
// Hermetic, mocked, no secrets: reads npm pack --dry-run --json output only.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const ALLOW = new Set(['dist', 'skills', 'plugin.json', 'README.md', 'LICENSE', 'package.json']);
const FORBIDDEN = ['IDENTITY.md', 'SOUL.md', 'USER.md'];

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);

// 1. Root packed file list
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }).replace(/^[^\[]*/, ''));
const packed = pack[0].files.map((f) => f.path);
ok(`root pack lists ${packed.length} files`);
for (const p of packed) {
  const top = p.split('/')[0];
  if (!ALLOW.has(top)) fail(`root pack includes non-allowlisted top-level entry: ${p}`);
}
if (!packed.includes('dist/ops.js')) fail('root pack missing dist/ops.js');
else ok('root pack includes dist/ops.js');
for (const f of FORBIDDEN) {
  if (packed.some((p) => p.split('/').includes(f))) fail(`root pack includes private file: ${f}`);
}

// 2. Materialized host dependency
const dep = join(root, 'hosts', 'openclaw', 'node_modules', 'groupmetoolkit');
if (!existsSync(join(dep, 'dist', 'ops.js'))) fail('host dependency missing dist/ops.js');
else ok('host dependency has dist/ops.js');

const walk = (dir, base = dir) =>
  readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });
for (const f of FORBIDDEN) {
  if (walk(dep).some((p) => p.split('/').includes(f))) fail(`host dependency includes private file: ${f}`);
}
ok('host dependency private-file scan done');

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('PASS package artifact + host dependency non-disclosure checks');
