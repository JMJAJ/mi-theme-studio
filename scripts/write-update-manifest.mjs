// Writes release/latest.json, the file the in-app updater reads from the
// latest GitHub release: version, notes and the signed installer's address.
// Runs after a signed build (tauri.updater.conf.json turns signing on).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const conf = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const repo = process.env.GITHUB_REPOSITORY ?? 'JMJAJ/mi-theme-studio';
const installer = `${conf.productName}_${pkg.version}_x64-setup.exe`;
const sigPath = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `${installer}.sig`);

const signature = (await readFile(sigPath, 'utf8').catch(() => {
  throw new Error(`No updater signature at ${sigPath}. Set TAURI_SIGNING_PRIVATE_KEY and build with --config src-tauri/tauri.updater.conf.json.`);
})).trim();

// GitHub stores uploaded file names with spaces turned into dots.
const asset = installer.replace(/ /g, '.');
const manifest = {
  version: pkg.version,
  notes: `Mi Theme Studio ${pkg.version}. See what's new: https://github.com/${repo}/releases/tag/v${pkg.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature, url: `https://github.com/${repo}/releases/download/v${pkg.version}/${encodeURIComponent(asset)}` },
  },
};
await writeFile(path.join(root, 'release', 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Update manifest for ${pkg.version} written to release/latest.json`);
