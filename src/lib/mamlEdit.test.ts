import { describe, expect, it } from 'vitest';
import { findStartTag, groupElements, lenientXml, removeElements, setAttributes, ungroupElement } from './mamlEdit';

const doc = `<?xml version="1.0"?>
<!-- <Fake x="1"/> -->
<Lockscreen screenWidth="1080">
  <Group x="10">
    <Text name="clock" x="100" y='200' color="#ffffffff" text="a > b"/>
    <Image src="bg.png" />
  </Group>
</Lockscreen>`;

describe('mamlEdit', () => {
  it('finds start tags in document order, skipping comments', () => {
    expect(findStartTag(doc, 0)?.name).toBe('Lockscreen');
    expect(findStartTag(doc, 2)?.name).toBe('Text');
    expect(findStartTag(doc, 3)?.name).toBe('Image');
    expect(findStartTag(doc, 4)).toBeNull();
  });
  it('changes, adds and removes attributes in place', () => {
    const out = setAttributes(doc, 2, { x: '150', y: '#a+1', size: '40', color: null });
    expect(out).toContain(`<Text name="clock" x="150" y="#a+1" text="a > b" size="40" />`);
    expect(out).toContain('<!-- <Fake x="1"/> -->');
  });
  it('escapes values and handles open tags', () => {
    const out = setAttributes(doc, 1, { visibility: 'a & "b"' });
    expect(out).toContain(`<Group x="10" visibility="a &amp; &quot;b&quot;">`);
    expect(setAttributes(doc, 3, { w: '5' })).toContain('<Image src="bg.png" w="5" />');
  });
});

describe('lenientXml', () => {
  it('keeps the last value of a repeated attribute and escapes a bare &', () => {
    const src = '<Lockscreen><Rectangle alpha="240" w="8" alpha="120" visibility="#a&#b"/><Text text="a &amp; b"/></Lockscreen>';
    const out = lenientXml(src);
    expect(out).toBe('<Lockscreen><Rectangle alpha="120" w="8" visibility="#a&amp;#b"/><Text text="a &amp; b"/></Lockscreen>');
  });

  it('separates attributes written without a space', () => {
    const src = '<Lockscreen><Text x="155" align="left"alpha="#qq2"/></Lockscreen>';
    const out = lenientXml(src);
    expect(out).toBe('<Lockscreen><Text x="155" align="left" alpha="#qq2"/></Lockscreen>');
  });
});

describe('removeElements', () => {
  const src = `<Lockscreen>
  <Image src="a.png"/>
  <Group x="1">
    <Text text="t"/>
  </Group>
  <Time src="t.png" />
</Lockscreen>
`;
  it('removes a self-closing element and its line', () => {
    expect(removeElements(src, [1])).toBe(`<Lockscreen>
  <Group x="1">
    <Text text="t"/>
  </Group>
  <Time src="t.png" />
</Lockscreen>
`);
  });
  it('removes an element with its children, and skips children of removed parents', () => {
    expect(removeElements(src, [3, 2, 4])).toBe(`<Lockscreen>
  <Image src="a.png"/>
</Lockscreen>
`);
  });
  it('keeps the line when other content shares it', () => {
    expect(removeElements('<A><B/><C/></A>', [1])).toBe('<A><C/></A>');
  });
});

describe('groupElements / ungroupElement', () => {
  const src = `<Lockscreen>
  <Text name="a" x="1"/>
  <Image src="b.png">
    <AlphaAnimation/>
  </Image>
  <Text name="c"/>
  <Text name="d"/>
</Lockscreen>`;

  it('wraps siblings in a group where the first one was', () => {
    const done = groupElements(src, [4, 1], { name: 'g' })!;
    expect(done.text).toBe(`<Lockscreen>
  <Group name="g">
    <Text name="a" x="1"/>
    <Text name="c"/>
  </Group>
  <Image src="b.png">
    <AlphaAnimation/>
  </Image>
  <Text name="d"/>
</Lockscreen>`);
    expect(findStartTag(done.text, done.ord)?.name).toBe('Group');
  });

  it('keeps inner indentation and undoes cleanly', () => {
    const done = groupElements(src, [2, 4], { name: 'g' })!;
    expect(done.text).toContain(`  <Group name="g">
    <Image src="b.png">
      <AlphaAnimation/>
    </Image>
    <Text name="c"/>
  </Group>`);
    expect(done.ord).toBe(2);
    expect(ungroupElement(done.text, done.ord)).toBe(src);
  });

  it('handles pieces on one line', () => {
    const one = '<L><A/><B/><C/></L>';
    const done = groupElements(one, [1, 3], { name: 'g' })!;
    expect(done.text).toBe('<L><Group name="g"><A/><C/></Group><B/></L>');
    expect(ungroupElement(done.text, done.ord)).toBe('<L><A/><C/><B/></L>');
  });
});
