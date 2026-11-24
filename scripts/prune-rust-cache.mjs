// Cargo never deletes stale build output: every feature set, env/flag change and
// dependency bump adds another copy under src-tauri/target. This runs before the
// Rust build scripts and cleans a profile once it passes the limit, so the cache
// cannot quietly grow to ~100 GB again.
// Limit per profile in GB: MTS_TARGET_LIMIT_GB (default 15). Set it to 0 to skip.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

const limitGb = Number(process.env.MTS_TARGET_LIMIT_GB ?? 15);
if (!limitGb) process.exit(0);

const target = path.resolve('src-tauri', 'target');

const sizeOf = (dir) => {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += lstatSync(p).size;
        } catch {}
      }
    }
  }
  return total;
};

for (const [dir, profile] of [['debug', 'dev'], ['release', 'release']]) {
  const full = path.join(target, dir);
  if (!existsSync(full)) continue;
  const gb = sizeOf(full) / 1024 ** 3;
  if (gb <= limitGb) continue;
  console.warn(`src-tauri/target/${dir} is ${gb.toFixed(1)} GB (limit ${limitGb} GB), cleaning it.`);
  const r = spawnSync(
    'cargo',
    ['clean', '--manifest-path', 'src-tauri/Cargo.toml', '--profile', profile],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) console.warn(`cargo clean --profile ${profile} failed; delete ${full} by hand.`);
}
