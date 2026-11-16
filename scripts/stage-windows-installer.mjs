import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectRoot, 'release');
const bundleDir = path.join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(await readFile(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const installerName = `${tauriConfig.productName}_${packageJson.version}_x64-setup.exe`;
const productName = tauriConfig.productName;
const installerPath = path.join(bundleDir, installerName);

const installerStat = await lstat(installerPath).catch(() => null);
if (!installerStat?.isFile()) {
  throw new Error(`Expected Windows installer was not produced: ${installerPath}`);
}

await mkdir(outputDir, { recursive: true });
const outputStat = await lstat(outputDir);
if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
  throw new Error(`Installer output must be a real directory: ${outputDir}`);
}

for (const entry of await readdir(outputDir, { withFileTypes: true })) {
  const isOldBuildOutput =
    entry.name === 'win-unpacked' ||
    entry.name === 'builder-debug.yml' ||
    entry.name === 'latest.yml' ||
    ((entry.name.startsWith(`${productName}_`) || entry.name.startsWith(`${productName} `)) &&
      (entry.name.endsWith('.exe') || entry.name.endsWith('.blockmap')));
  if (!isOldBuildOutput) continue;

  const oldPath = path.resolve(outputDir, entry.name);
  if (path.dirname(oldPath) !== outputDir) {
    throw new Error(`Refusing to remove a path outside the release directory: ${oldPath}`);
  }
  await rm(oldPath, { recursive: entry.isDirectory() || entry.isSymbolicLink(), force: true });
}

await copyFile(installerPath, path.join(outputDir, installerName));
console.log(`Windows installer staged at ${path.join(outputDir, installerName)}`);
