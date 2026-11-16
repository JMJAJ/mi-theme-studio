// Bump the app version (package.json → tauri.conf.json via "../package.json",
// and src-tauri/Cargo.toml). Every installer build gets a new version, so
// Windows setup always replaces the installed copy instead of treating it as
// the same release.
//   node scripts/bump-version.mjs            → patch (0.3.0 → 0.3.1)
//   node scripts/bump-version.mjs minor      → 0.3.1 → 0.4.0
//   node scripts/bump-version.mjs 1.0.0      → exact
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
const lockPath = path.join(root, 'src-tauri', 'Cargo.lock');

const pkgText = await readFile(pkgPath, 'utf8');
const current = JSON.parse(pkgText).version;
const [major, minor, patch] = current.split('.').map(Number);
const arg = process.argv[2] ?? 'patch';
const next = /^\d+\.\d+\.\d+$/.test(arg)
  ? arg
  : arg === 'major'
    ? `${major + 1}.0.0`
    : arg === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

await writeFile(pkgPath, pkgText.replace(`"version": "${current}"`, `"version": "${next}"`));
const cargo = await readFile(cargoPath, 'utf8');
await writeFile(cargoPath, cargo.replace(/^version = "[^"]+"/m, `version = "${next}"`));
const lock = await readFile(lockPath, 'utf8').catch(() => null);
if (lock) {
  await writeFile(lockPath, lock.replace(/(name = "mi-theme-studio"\r?\nversion = )"[^"]+"/, `$1"${next}"`));
}
console.log(`Version ${current} → ${next}`);
