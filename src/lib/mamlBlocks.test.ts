import { describe, expect, it } from 'vitest';
import { findStartTag } from './mamlEdit';
import { BASIC_BLOCKS, imageBlock, insertBlock, LOCK_BLOCKS } from './mamlBlocks';

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

describe('basic blocks', () => {
  const block = (id: string) => BASIC_BLOCKS.find((b) => b.id === id)!;

  it('centres a single element and returns its ordinal', () => {
    const done = insertBlock(LOCK, block('text'), 0, 1080, 500)!;
    expect(nameAt(done.text, done.ord)).toBe('text_1');
    expect(done.text).toMatch(/<Text name="text_1" x="540" y="500" align="center"/);
  });

  it('fills the circle centre, line end and box edge placeholders, scaled to the layout', () => {
    const circle = insertBlock(LOCK, block('circle'), 0, 720, 100)!;
    expect(circle.text).toMatch(/<Circle name="circle_1" x="360" y="180" r="80"/);
    const line = insertBlock(LOCK, block('line'), 0, 1080, 300)!;
    expect(line.text).toMatch(/x="240" y="300" x1="840" y1="300"/);
    expect(line.text).not.toMatch(/\{/);
  });

  it('numbers repeated pieces and places pictures with an escaped path', () => {
    const once = insertBlock(LOCK, block('rect'), 0, 1080, 0)!;
    const twice = insertBlock(once.text, block('rect'), 0, 1080, 0)!;
    expect(nameAt(twice.text, twice.ord)).toBe('rect_2');
    const pic = insertBlock(LOCK, imageBlock('mts_images/a&b.png', 400, 200), 1, 1080, 50)!;
    expect(pic.text).toMatch(/<Image name="image_1" x="340" y="50" w="400" h="200" src="mts_images\/a&amp;b.png"\/>/);
    expect(nameAt(pic.text, pic.ord)).toBe('image_1');
  });
});
