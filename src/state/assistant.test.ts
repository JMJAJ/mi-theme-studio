import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../lib/types';

type Module = typeof import('./assistant');
let changesSince: Module['changesSince'];

beforeAll(async () => {
  // The assistant keeps chats in localStorage; give the node test a stand-in.
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    window: Object.assign(globalThis, { addEventListener() {}, setTimeout, clearTimeout }),
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
  ({ changesSince } = await import('./assistant'));
});

const project = (history: ProjectSnapshot['history'], sourcePath = 'C:/a.mtz') => ({ sourcePath, name: 'a', history }) as ProjectSnapshot;
const step = (id: number, atMs: number, done = true, label = `step ${id}`) => ({ id, atMs, done, label, files: 1 });

describe('rewind checkpoints', () => {
  const prompt = (id: number | null, atMs: number | null, at = 5000) => ({ id: 'u', role: 'user' as const, text: 'x', at, checkpoint: { project: 'C:/a.mtz', id, atMs } });

  it('lists the applied steps after the checkpoint', () => {
    const p = project([step(1, 1000), step(2, 6000), step(3, 7000), step(4, 8000, false)]);
    expect(changesSince(prompt(1, 1000), p)).toEqual(['step 2', 'step 3']);
    expect(changesSince(prompt(3, 7000), p)).toEqual([]);
  });

  it('treats "as opened" as valid only when every step came after the prompt', () => {
    expect(changesSince(prompt(null, null), project([step(1, 6000)]))).toEqual(['step 1']);
    expect(changesSince(prompt(null, null), project([step(1, 1000)]))).toBeNull();
  });

  it('refuses another theme or a step that no longer exists', () => {
    expect(changesSince(prompt(1, 1000), project([step(1, 1000)], 'C:/b.mtz'))).toBeNull();
    // Same id from a reopened package, different time.
    expect(changesSince(prompt(1, 1000), project([step(1, 9000)]))).toBeNull();
    expect(changesSince({ id: 'u', role: 'user', text: 'x' }, project([]))).toBeNull();
  });
});
