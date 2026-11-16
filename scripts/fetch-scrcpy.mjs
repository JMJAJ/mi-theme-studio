// Downloads the pinned scrcpy Windows release into src-tauri/resources/scrcpy
// so it is bundled with the installer. scrcpy is Apache-2.0
// (https://github.com/Genymobile/scrcpy); its bundled libraries keep their own
// licenses (FFmpeg LGPL, SDL zlib, libusb LGPL, adb Apache-2.0).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3.3.1';
const ZIP_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-win64-v${VERSION}.zip`;
const ZIP_SHA256 = '4fcad494772a3ae5de9a133149f8856d2fc429b41795f7cf7c754e0c1bb6fbc0';
const LICENSE_URL = `https://raw.githubusercontent.com/Genymobile/scrcpy/v${VERSION}/LICENSE`;
const KEEP = [
  'scrcpy.exe',
  'scrcpy-server',
  'adb.exe',
  'AdbWinApi.dll',
  'AdbWinUsbApi.dll',
  'SDL2.dll',
  'avcodec-61.dll',
  'avformat-61.dll',
  'avutil-59.dll',
  'swresample-5.dll',
  'libusb-1.0.dll',
  'icon.png',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src-tauri', 'resources', 'scrcpy');
const marker = path.join(target, 'VERSION');

const current = await readFile(marker, 'utf8').catch(() => '');
if (current.trim() === VERSION && (await stat(path.join(target, 'scrcpy.exe')).catch(() => null))) {
  console.log(`scrcpy ${VERSION} already present`);
  process.exit(0);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

console.log(`Fetching scrcpy ${VERSION}…`);
const zip = await download(ZIP_URL);
const digest = createHash('sha256').update(zip).digest('hex');
if (digest !== ZIP_SHA256) throw new Error(`scrcpy checksum mismatch: ${digest}`);

const work = path.join(os.tmpdir(), `mts-scrcpy-${process.pid}`);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const zipPath = path.join(work, 'scrcpy.zip');
await writeFile(zipPath, zip);
// Windows 10+ ships bsdtar, which extracts zip archives. Use it explicitly:
// a GNU tar earlier on PATH (Git for Windows) reads `C:` as a remote host.
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tarExe, ['-xf', zipPath, '-C', work], { stdio: 'inherit' });
const extracted = path.join(work, `scrcpy-win64-v${VERSION}`);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of KEEP) await cp(path.join(extracted, name), path.join(target, name));
const license = await download(LICENSE_URL);
await writeFile(
  path.join(target, 'NOTICE.txt'),
  `scrcpy ${VERSION} by Genymobile and contributors, ${ZIP_URL}\n` +
    `Bundled unmodified. scrcpy and adb: Apache License 2.0. FFmpeg (avcodec, avformat, avutil, swresample): LGPL 2.1+. SDL2: zlib. libusb: LGPL 2.1+.\n\n` +
    license.toString('utf8'),
);
await writeFile(marker, VERSION + '\n');
await rm(work, { recursive: true, force: true });
console.log(`scrcpy ${VERSION} ready in ${path.relative(root, target)}`);
