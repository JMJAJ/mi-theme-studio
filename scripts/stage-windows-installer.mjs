import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

// On Windows, `release` is a junction to a folder outside the project.
// Programs that live inside the project folder can be barred from writing to
// %TEMP% by workspace sandboxes, and an NSIS setup must unpack there; through
// the junction the setup's real location is outside the project, so it runs.
// CI keeps a plain folder.
const externalDir = process.env.MTS_RELEASE_DIR ?? path.join(os.homedir(), `${tauriConfig.productName} Releases`);
const useJunction = process.platform === 'win32' && !process.env.CI;
if (useJunction) {
  await mkdir(externalDir, { recursive: true });
  const current = await lstat(outputDir).catch(() => null);
  if (current && !current.isSymbolicLink()) {
    if (!current.isDirectory()) throw new Error(`Not a directory: ${outputDir}`);
    for (const entry of await readdir(outputDir)) {
      await rename(path.join(outputDir, entry), path.join(externalDir, entry)).catch(async () => {
        await cp(path.join(outputDir, entry), path.join(externalDir, entry), { recursive: true });
      });
    }
    await rm(outputDir, { recursive: true, force: true });
  }
  if (!(await lstat(outputDir).catch(() => null))) await symlink(externalDir, outputDir, 'junction');
  const target = await realpath(outputDir);
  if (target.toLowerCase() !== (await realpath(externalDir)).toLowerCase()) {
    throw new Error(`${outputDir} points to ${target}, expected ${externalDir}. Remove it and build again.`);
  }
} else {
  await mkdir(outputDir, { recursive: true });
  const outputStat = await lstat(outputDir);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error(`Installer output must be a real directory: ${outputDir}`);
  }
}

for (const entry of await readdir(outputDir, { withFileTypes: true })) {
  const isOldBuildOutput =
    entry.name === 'win-unpacked' ||
    entry.name === 'builder-debug.yml' ||
    entry.name === 'latest.yml' ||
    ((entry.name.startsWith(`${productName}_`) || entry.name.startsWith(`${productName} `)) &&
      (entry.name.endsWith('.exe') || entry.name.endsWith('.blockmap') || entry.name.endsWith('.zip')));
  if (!isOldBuildOutput) continue;

  const oldPath = path.resolve(outputDir, entry.name);
  if (path.dirname(oldPath) !== path.resolve(outputDir)) {
    throw new Error(`Refusing to remove a path outside the release directory: ${oldPath}`);
  }
  await rm(oldPath, { recursive: entry.isDirectory() || entry.isSymbolicLink(), force: true });
}

await copyFile(installerPath, path.join(outputDir, installerName));
console.log(`Windows installer staged at ${path.join(outputDir, installerName)}`);

// Portable build: the app and its bundled resources in a zip. Needs no
// installer and never unpacks into %TEMP% (useful when a sandbox or security
// tool stops setup programs from writing there).
const releaseDir = path.join(projectRoot, 'src-tauri', 'target', 'release');
const portableName = `${productName}_${packageJson.version}_x64-portable.zip`;
const stagingDir = path.join(projectRoot, 'src-tauri', 'target', 'portable', productName);
await rm(path.dirname(stagingDir), { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
await copyFile(path.join(releaseDir, 'mi-theme-studio.exe'), path.join(stagingDir, `${productName}.exe`));
await cp(path.join(releaseDir, 'scrcpy'), path.join(stagingDir, 'scrcpy'), { recursive: true });
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tarExe, ['-a', '-c', '-f', path.join(outputDir, portableName), '-C', path.dirname(stagingDir), productName], { stdio: 'inherit' });
console.log(`Portable build staged at ${path.join(outputDir, portableName)}`);
