import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(import.meta.dirname, '..', 'dist');

// NOTE: dist/packages holds the type declarations that dist/index.d.ts (etc.) re-export —
// the package.json `types` conditions depend on it, so it must ship.

// Remove all .map files
function removeMaps(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      removeMaps(fullPath);
    } else if (entry.endsWith('.map')) {
      rmSync(fullPath, { force: true });
    }
  }
}

removeMaps(distDir);
console.log('Prepublish cleanup complete: removed sourcemaps.');
