import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(import.meta.dirname, '..', 'dist');

// Remove type declaration subdirectory (saves ~2MB)
rmSync(join(distDir, 'packages'), { recursive: true, force: true });

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
console.log('Prepublish cleanup complete: removed sourcemaps and type declarations.');
