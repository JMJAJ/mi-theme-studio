import { describe, expect, it } from 'vitest';
import { findStartTag } from './mamlEdit';
import { insertBlock, LOCK_BLOCKS } from './mamlBlocks';

const LOCK = `<Lockscreen version="1" frameRate="60">
    <Group name="a" visibility="eq(#pg,0)">
        <Text text="one"/>
    </Group>
    <Group name="b" visibility="eq(#pg,1)">
        <Text text="two"/>
    </Group>
</Lockscreen>`;

const nameAt = (text: string, ord: number) => {
  const tag = findStartTag(text, ord)!;
  return /name="([^"]*)"/.exec(text.slice(tag.start, tag.end))?.[1];
};

describe('insertBlock', () => {
  it('puts the block inside the target group and adds its data source once', () => {
    const weather = LOCK_BLOCKS.find((b) => b.id === 'weather')!;
    // Ordinal 3 is group "b" (Lockscreen 0, a 1, Text 2, b 3).
    const first = insertBlock(LOCK, weather, 3, 1080, 1000)!;
    expect(nameAt(first.text, first.ord)).toBe('weather_1');
    const b = first.text.indexOf('<Group name="b"');
    const end = first.text.indexOf('</Group>', b);
    const at = first.text.indexOf('<Group name="weather_1"');
    expect(at > b && at < end).toBe(true);
    expect(first.text).toContain('x="320" y="1000"');
    expect(first.text.match(/name="mts_weather"/g)).toHaveLength(1);
    expect(first.text.indexOf('<VariableBinders>')).toBeLessThan(first.text.indexOf('<Group name="a"'));

    const second = insertBlock(first.text, weather, 0, 1080, 400)!;
    expect(second.text.match(/name="mts_weather"/g)).toHaveLength(1);
    expect(nameAt(second.text, second.ord)).toBe('weather_2');
    expect(second.text.trimEnd().endsWith('</Group>\n</Lockscreen>')).toBe(true);
  });

  it('scales sizes to the layout width', () => {
    const bar = LOCK_BLOCKS.find((b) => b.id === 'battery')!;
    const out = insertBlock(LOCK, bar, 0, 720, 500)!.text;
    expect(out).toContain('w="560" h="60"');
    expect(out).toContain('w="347*#battery_level/100"');
  });
});
