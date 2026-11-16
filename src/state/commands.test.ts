import { describe, expect, it } from 'vitest';

describe('command registry', () => {
  it('has unique ids and non-conflicting shortcuts', async () => {
    const { COMMANDS, MENUS, commandById } = await import('./commands');
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = COMMANDS.flatMap((c) => [c.shortcut, ...(c.alt ?? [])].filter(Boolean).map((k) => k!.toLowerCase()));
    expect(new Set(keys).size).toBe(keys.length);
    for (const menu of MENUS) {
      for (const entry of menu.items) {
        if (typeof entry === 'string' && entry !== '-' && entry !== 'recent') expect(commandById.has(entry), entry).toBe(true);
      }
    }
  });
});
