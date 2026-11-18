import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, slug } from './markdown';

describe('markdown', () => {
  it('makes GitHub-style anchors', () => {
    expect(slug('x, y and alignment')).toBe('x-y-and-alignment');
    expect(slug('It shows `0`')).toBe('it-shows-0');
    expect(slug('Digit-picture clocks')).toBe('digit-picture-clocks');
  });

  it('reads the blocks the guide uses', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'One line',
        'and the next.',
        '',
        '![Alt](img/a.svg)',
        '',
        '| A | B |',
        '| --- | --- |',
        '| `#a&#124;&#124;#b` | x |',
        '',
        '```xml',
        '<Text text="a"/>',
        '```',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '---',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'img', 'table', 'code', 'ul', 'ol', 'hr']);
    expect(blocks[1]).toEqual({ t: 'p', text: 'One line and the next.' });
    expect(blocks[3]).toEqual({ t: 'table', head: ['A', 'B'], rows: [['`#a||#b`', 'x']] });
    expect(blocks[4]).toEqual({ t: 'code', lang: 'xml', text: '<Text text="a"/>' });
  });

  it('reads inline code, bold, italic and links', () => {
    expect(parseInline('a `b*c` **bold `x`** *it* [link `y`](p.md#h)')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b*c' },
      { t: 'text', v: ' ' },
      { t: 'b', v: [{ t: 'text', v: 'bold ' }, { t: 'code', v: 'x' }] },
      { t: 'text', v: ' ' },
      { t: 'i', v: [{ t: 'text', v: 'it' }] },
      { t: 'text', v: ' ' },
      { t: 'a', href: 'p.md#h', v: [{ t: 'text', v: 'link ' }, { t: 'code', v: 'y' }] },
    ]);
  });

  it('leaves a lone star alone', () => {
    expect(parseInline('2 * 3')).toEqual([{ t: 'text', v: '2 * 3' }]);
  });
});
