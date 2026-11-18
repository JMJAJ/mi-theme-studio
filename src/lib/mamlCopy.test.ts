import { describe, expect, it } from 'vitest';
import { findStartTag } from './mamlEdit';
import { pasteSnippet, prefixPaths, referencedFiles, references, renameAll, type Snippet } from './mamlCopy';

const FILES = ['time_0.png', 'time_1.png', 'time_dot.png', 'time.png', 'weather/w_1.png', 'weather/w_2.png', 'bg.png', 'other.png'];

describe('referencedFiles', () => {
  it('finds pictures, digit sets and formula paths', () => {
    const xml = `<Time src="time.png"/><Image srcExp="'weather/w_'+#id+'.png'"/><Image src="/bg.png"/>`;
    expect(referencedFiles(xml, FILES).sort()).toEqual(['bg.png', 'time.png', 'time_0.png', 'time_1.png', 'time_dot.png', 'weather/w_1.png', 'weather/w_2.png'].sort());
  });
  it('follows %d patterns', () => {
    expect(referencedFiles(`<Image srcFormat="weather/w_%d.png" srcParas="#id"/>`, FILES).sort()).toEqual(['weather/w_1.png', 'weather/w_2.png']);
  });
});

describe('references / renameAll / prefixPaths', () => {
  it('reads and renames names', () => {
    const xml = `<Text textExp="@city+#temp" name="t"/><VariableCommand name="pg" expression="#pg+1"/><Command target="t.visibility" value="1"/>`;
    expect([...references(xml)].sort()).toEqual(['city', 'pg', 't', 'temp']);
    const out = renameAll(xml, new Map([['t', 't_2'], ['temp', 'temp_2']]));
    expect(out).toContain('#temp_2');
    expect(out).toContain('name="t_2"');
    expect(out).toContain('target="t_2.visibility"');
    expect(out).toContain('@city');
  });
  it('moves picture paths into a folder', () => {
    const xml = `<Image src="bg.png"/><Image srcExp="'weather/w_'+#id+'.png'"/><Text text="'weather'"/>`;
    const out = prefixPaths(xml, 'copied_1/', ['bg.png', 'weather/w_1.png']);
    expect(out).toContain('src="copied_1/bg.png"');
    expect(out).toContain(`srcExp="'copied_1/weather/w_'+#id+'.png'"`);
    expect(out).toContain(`text="'weather'"`);
  });
});

const TARGET = `<Lockscreen version="1" screenWidth="1080">
    <VariableBinders>
        <ContentProviderBinder name="w" uri="content://weather/actualWeatherData/1">
            <Variable name="city" type="string" column="city_name"/>
        </ContentProviderBinder>
    </VariableBinders>
    <Var name="temp" expression="1"/>
    <Group name="page">
        <Text name="label" text="hi"/>
    </Group>
</Lockscreen>`;

const nameAt = (text: string, ord: number) => {
  const tag = findStartTag(text, ord)!;
  return /name="([^"]*)"/.exec(text.slice(tag.start, tag.end))?.[1];
};

describe('pasteSnippet', () => {
  it('reuses identical definitions, renames clashes and moves clashing pictures', () => {
    const snip: Snippet = {
      name: 'Weather card',
      elements: [`<Text name="label" textExp="@city+#temp"/>`, `<Image src="bg.png"/>`],
      defs: [`<Var name="temp" expression="#raw*2"/>`],
      binders: [`<ContentProviderBinder name="w" uri="content://weather/actualWeatherData/1">\n    <Variable name="city" type="string" column="city_name"/>\n</ContentProviderBinder>`],
      files: ['bg.png'],
      offset: { x: 100, y: 200 },
      box: null,
      width: 1080,
    };
    const out = pasteSnippet(TARGET, snip, { target: 0, targetOffset: { x: 0, y: 0 }, targetFiles: new Map([['bg.png', 10]]), sourceSizes: new Map([['bg.png', 20]]) })!;
    expect(out.text.match(/<ContentProviderBinder/g)).toHaveLength(1);
    expect(out.text).toContain('<Var name="temp_2" expression="#raw*2"/>');
    expect(out.text).toContain('name="label_2" textExp="@city+#temp_2"');
    expect(out.text).toContain('src="copied_1/bg.png"');
    expect(out.writes).toEqual([{ from: 'bg.png', to: 'copied_1/bg.png' }]);
    expect(nameAt(out.text, out.ord)).toBe('Weather_card_1');
    expect(out.text).toContain('<Group name="Weather_card_1" x="100" y="200">');
  });

  it('moves a single plain piece instead of wrapping it, and adds new data sources', () => {
    const snip: Snippet = {
      name: 'x',
      elements: [`<Text name="steps" x="10" y="20" format="%d" paras="#n"/>`],
      defs: [],
      binders: [`<ContentProviderBinder name="s" uri="content://steps">\n    <Variable name="n" type="int" column="steps"/>\n</ContentProviderBinder>`],
      files: [],
      offset: { x: 5, y: 5 },
      box: null,
      width: 1080,
    };
    const out = pasteSnippet(TARGET, snip, { target: 0, targetOffset: { x: 0, y: 0 }, targetFiles: new Map(), sourceSizes: new Map(), visibility: 'eq(#pg,1)' })!;
    expect(out.text).toContain('<Text name="steps" x="15" y="25" format="%d" paras="#n" visibility="eq(#pg,1)" />');
    expect(out.text.match(/<ContentProviderBinder/g)).toHaveLength(2);
    expect(nameAt(out.text, out.ord)).toBe('steps');
    expect(out.writes).toEqual([]);
  });
});
