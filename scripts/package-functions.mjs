// Allowlist packaging: local settings, backups, tests and checked-in dependencies
// must never be included in a deployment archive. Optional dependencies must come
// from a clean npm-ci directory, not the checked-in api/node_modules tree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'api');
const output = process.argv[2];
const dependenciesRoot = process.argv[3] && path.resolve(process.argv[3]);
if (!output || !path.isAbsolute(output) || !output.endsWith('.zip')) {
  throw new Error('Supply an absolute, new .zip output path.');
}
if (fs.existsSync(output)) throw new Error('Refusing to append to an existing deployment archive.');
const files = ['host.json', 'package.json', 'package-lock.json'];
for (const entry of fs.readdirSync(api, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name !== '_shared' && !fs.existsSync(path.join(api, entry.name, 'function.json'))) continue;
  for (const file of fs.readdirSync(path.join(api, entry.name), { withFileTypes: true })) {
    if (file.isFile() && (file.name.endsWith('.js') || file.name === 'function.json')) {
      files.push(`${entry.name}/${file.name}`);
    }
  }
}
const result = spawnSync('zip', ['-q', output, ...files.sort()], { cwd: api, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
if (dependenciesRoot) {
  if (dependenciesRoot === api || dependenciesRoot === root) throw new Error('Use a clean dependency staging directory.');
  if (fs.readFileSync(path.join(dependenciesRoot, 'package-lock.json'), 'utf8') !== fs.readFileSync(path.join(api, 'package-lock.json'), 'utf8')) {
    throw new Error('Dependency lockfile does not match the release.');
  }
  function rejectNativeBinaries(directory) {
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, file.name);
      if (file.isDirectory()) rejectNativeBinaries(absolute);
      else if (file.name.endsWith('.node')) throw new Error('Native dependency found; build this artifact on Linux.');
    }
  }
  rejectNativeBinaries(path.join(dependenciesRoot, 'node_modules'));
  const deps = spawnSync('zip', ['-q', '-r', output, 'node_modules'], { cwd: dependenciesRoot, stdio: 'inherit' });
  if (deps.status !== 0) process.exit(deps.status || 1);
}
console.log(`Packaged ${files.length} allowlisted files: ${output}`);
