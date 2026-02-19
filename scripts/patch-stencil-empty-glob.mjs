import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.cwd(), 'node_modules/@stencil/core/internal/client/index.js');

if (!existsSync(target)) {
  console.log('[patch-stencil-empty-glob] target not found; skipping');
  process.exit(0);
}

const original = readFileSync(target, 'utf8');
const replacement = 'new URL("./" + bundleId + ".entry.js" + (BUILD5.hotModuleReplacement && hmrVersionId ? "?s-hmr=" + hmrVersionId : ""), import.meta.url).href';

if (original.includes(replacement)) {
  console.log('[patch-stencil-empty-glob] already patched');
  process.exit(0);
}

const patterns = [
  '`./${bundleId}.entry.js${BUILD5.hotModuleReplacement && hmrVersionId ? "?s-hmr=" + hmrVersionId : ""}`',
  '("./" + bundleId + ".entry.js" + (BUILD5.hotModuleReplacement && hmrVersionId ? "?s-hmr=" + hmrVersionId : ""))'
];

let patched = original;
let changed = false;

for (const pattern of patterns) {
  if (patched.includes(pattern)) {
    patched = patched.replace(pattern, replacement);
    changed = true;
    break;
  }
}

if (!changed) {
  console.log('[patch-stencil-empty-glob] expected pattern not found; skipping');
  process.exit(0);
}

writeFileSync(target, patched);
console.log('[patch-stencil-empty-glob] patch applied');
