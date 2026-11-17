// Builds the Windows installer. When the updater signing key is available
// (TAURI_SIGNING_PRIVATE_KEY, or ~/.tauri/mi-theme-studio.key on this PC) the
// installer is signed and release/latest.json is written for the in-app updater.
// Without a key a local build still works, just unsigned; on CI a missing key fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd) => {
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const keyFile = path.join(os.homedir(), '.tauri', 'mi-theme-studio.key');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && existsSync(keyFile)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf8').trim();
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
}
const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
if (!signed && process.env.CI) {
  console.error('TAURI_SIGNING_PRIVATE_KEY is not set, so the release would have no update file. Add it as a repository secret.');
  process.exit(1);
}

run('node scripts/fetch-scrcpy.mjs');
run(`npx tauri build --bundles nsis${signed ? ' --config src-tauri/tauri.updater.conf.json' : ''}`);
run('node scripts/stage-windows-installer.mjs');
if (signed) run('node scripts/write-update-manifest.mjs');
else console.warn(`\nBuilt without update signing (no key at ${keyFile}). The app works, but it is not offered through the in-app updater.`);
