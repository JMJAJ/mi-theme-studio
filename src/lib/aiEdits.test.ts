import { describe, expect, it } from 'vitest';
import { applyEdits, lineDiff, locate, parseToolArgs } from './aiEdits';

const text = ['<Lockscreen>', '  <Text text="a"/>', '  <Image src="b.png"/>', '  <Text text="c"/>', '</Lockscreen>'].join('\n');

describe('applyEdits', () => {
  it('reports where each replacement landed', () => {
    const { after, locations } = applyEdits('m.xml', text, [
      { old_text: 'src="b.png"', new_text: 'src="big.png"' },
      { old_text: 'text="c"', new_text: 'text="c"\n    size="40"' },
    ]);
    expect(after).toContain('src="big.png"');
    expect(locations.map((l) => [l.line, l.column, l.endLine])).toEqual([
      [3, 10, 3],
      [4, 9, 5],
    ]);
  });

  it('keeps earlier ranges right when a later edit is above them', () => {
    const { locations } = applyEdits('m.xml', text, [
      { old_text: 'text="c"', new_text: 'text="cc"' },
      { old_text: '  <Text text="a"/>', new_text: '  <Text text="a"/>\n  <Text text="new"/>' },
    ]);
    expect(locations.map((l) => l.line)).toEqual([2, 5]);
  });

  it('handles replace_all and rejects ambiguous text', () => {
    expect(() => applyEdits('m.xml', text, [{ old_text: '<Text', new_text: '<T' }])).toThrow(/2 times/);
    const { locations } = applyEdits('m.xml', text, [{ old_text: '<Text', new_text: '<Txt', replace_all: true }]);
    expect(locations.map((l) => l.line)).toEqual([2, 4]);
  });

  it('fails clearly when the text is missing', () => {
    expect(() => applyEdits('m.xml', text, [{ old_text: 'nope', new_text: 'x' }])).toThrow(/not found/);
  });
});

describe('locate / lineDiff', () => {
  it('counts characters, not bytes', () => {
    expect(locate('a', 'é😀x\nyz', 3, 1)).toMatchObject({ line: 1, column: 3, length: 1 });
  });
  it('marks added and removed lines', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ B');
    expect(diff.startsWith('@@ line 2')).toBe(true);
  });
});

describe('parseToolArgs', () => {
  it('reads clean, empty and slightly broken arguments', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs('')).toEqual({});
    expect(parseToolArgs('{"path":"x","edits":[{"old_text":"a","new_text":"b"}]})\n')).toEqual({ path: 'x', edits: [{ old_text: 'a', new_text: 'b' }] });
    expect(parseToolArgs('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseToolArgs('not json')).toBeNull();
  });
});
