import { describe, expect, it } from 'vitest';
import { formulaProblems } from './mamlHelp';
import { sampleVars } from './mamlDocExamples';
import { runScript, scriptToLockscreen } from './playground';
import { SAMPLE_COLUMNS } from './sampleData';

const now = new Date(2026, 2, 17, 21, 5, 7);
const base = sampleVars(now);

const run = (src: string) => runScript(src, base, now).results;

describe('playground', () => {
  it('works out unrelated lines on their own', () => {
    const r = run(["// weather", "@weather_description+' '+@weather_temperature", '', 'date: d/M EE', 'fmt: %02d:%02d | #hour24,#minute', '360*#battery_level/100'].join('\n'));
    expect(r.map((x) => x.kind)).toEqual(['comment', 'value', 'empty', 'date', 'format', 'value']);
    expect(r[1].text).toBe('Clear 18℃');
    expect(r[3].text).toBe('17/3 Tue');
    expect(r[4].text).toBe('21:05');
    expect(r[5]).toMatchObject({ text: '295.2', type: 'number' });
  });

  it('lets later lines use names set earlier, and override phone values', () => {
    const r = run(["greeting = 'Hi, '+@name", "@greeting+'!'", 'battery_level = 15', "ifelse(#battery_level{20,'Low','OK')", 'visible: #battery_level{20'].join('\n'));
    expect(r[0]).toMatchObject({ kind: 'define', name: 'greeting', text: 'Hi, Alex' });
    expect(r[1].text).toBe('Hi, Alex!');
    expect(r[3].text).toBe('Low');
    expect(r[4]).toMatchObject({ kind: 'visible', shown: true });
    expect(r[1].problems).toEqual([]);
  });

  it('reads pasted MAML elements', () => {
    const r = run(['<Text textExp="strToUpperCase(@weather_city)" x="#screen_width/2" visibility="eq(#battery_state,1)"/>', '<DateTime format="EEEE"/>', '<Var name="n" expression="2+3"/>', '#n*2'].join('\n'));
    expect(r[0]).toMatchObject({ kind: 'element', tag: 'Text', text: 'YOUR CITY', shown: false });
    expect(r[0].extras).toEqual([['x', '540']]);
    expect(r[1].text).toBe('Tuesday');
    expect(r[2]).toMatchObject({ kind: 'define', name: 'n', text: '5' });
    expect(r[3].text).toBe('10');
  });

  it('points out mistakes per line', () => {
    const r = run(['#hour24<12', 'nope(1)', '#missing+1'].join('\n'));
    expect(r[0].problems[0]).toMatch(/\{ for less than/);
    expect(r[1].problems[0]).toMatch(/isn’t a function/);
    expect(r[2].problems[0]).toMatch(/isn’t a variable/);
    expect(formulaProblems('ifelse(eq(#a,1),2,3)', new Map([['a', 1]]))).toEqual([]);
  });

  it('turns the script into a lock screen for the Phone view', () => {
    const src = ["g = 'Hi'", '@g', 'date: HH:mm', '<Text text="x" y="100"/>'].join('\n');
    const xml = scriptToLockscreen(src, run(src));
    expect(xml).toContain('<Var name="g" type="string" expression="\'Hi\'"/>');
    expect(xml).toMatch(/<Text x="540" y="\d+" align="center" size="48" color="#ffffffff" textExp="@g"\/>/);
    expect(xml).toMatch(/<DateTime x="540" y="\d+" align="center" size="48" color="#ffffffff" format="HH:mm"\/>/);
    expect(xml).toContain('<Text text="x" y="100" x="540" align="center" size="48" color="#ffffffff"/>');
  });

  it('works out multi-line blocks: binders, groups and comments', () => {
    const src = [
      '<!-- added to <VariableBinders> once -->',
      '<ContentProviderBinder name="mts_steps" uri="content://com.mi.health.provider.main/activity/steps/brief" columns="steps,goal" countName="mts_has_steps">',
      '    <Variable name="mts_steps" type="int" column="steps"/>',
      '    <Variable name="mts_steps_goal" type="int" column="goal"/>',
      '</ContentProviderBinder>',
      '',
      '<Group name="steps_1" x="320" y="900" w="440" h="300">',
      '    <Rectangle name="steps_1_bg" x="0" y="0" w="440" h="300" cornerRadius="36" fillColor="#33ffffff"/>',
      '    <Text name="steps_1_label" x="36" y="36" size="34" color="#ccffffff" text="Steps"/>',
      '    <Text name="steps_1_count" x="36" y="96" size="96" bold="true" color="#ffffffff" format="%d" paras="#mts_steps"/>',
      '    <Rectangle name="steps_1_fill" x="36" y="240" w="368*min(#mts_steps/max(#mts_steps_goal,1),1)" h="20" cornerRadius="10" fillColor="#ffa8f0c0"/>',
      '</Group>',
      "#mts_steps+' of '+#mts_steps_goal",
    ].join('\n');
    const { results, units } = runScript(src, base, now);
    expect(results.map((r) => r.kind)).toEqual(['comment', 'binder', 'define', 'define', 'close', 'empty', 'element', 'element', 'element', 'element', 'element', 'close', 'value']);
    expect(results[1]).toMatchObject({ text: 'steps · sample data', extras: [['mts_has_steps', '1']] });
    expect(results[2]).toMatchObject({ name: 'mts_steps', text: '6532', type: 'number' });
    expect(results[9].text).toBe('6532');
    expect(results[10].extras).toEqual([['w', '300.472']]);
    expect(results[12].text).toBe('6532 of 8000');
    expect(results.every((r) => r.problems.length === 0)).toBe(true);
    expect(units.filter((u) => u.block).map((u) => [u.start, u.end])).toEqual([
      [0, 0],
      [1, 4],
      [6, 11],
    ]);
    const xml = scriptToLockscreen(src, results, units);
    expect(xml).toContain('<VariableBinders>\n<ContentProviderBinder name="mts_steps"');
    expect(xml).toContain('<Group name="steps_1" x="320"');
  });

  it('says when a block is not closed, and stops at plain lines', () => {
    const r = run(['<Group x="0">', '    <Text text="a"/>', '#battery_level'].join('\n'));
    expect(r[0].problems[0]).toBe('<Group> is not closed: add </Group>.');
    expect(r[2]).toMatchObject({ kind: 'value', text: '82' });
  });

  it('reads one element spread over several lines', () => {
    const r = run(['<Text', '    textExp="@weather_city"', '    size="40"/>', 'date: EEEE'].join('\n'));
    expect(r.map((x) => x.kind)).toEqual(['element', 'close', 'close', 'date']);
    expect(r[0].text).toBe('Your city');
  });

  it('uses live weather columns when given', () => {
    const cols = { ...SAMPLE_COLUMNS, city_name: ['Lisbon'], description: ['Rain'], temperature: ['9℃'] };
    const src = ['<ContentProviderBinder uri="content://weather/actualWeatherData/1" countName="w">', '<Variable name="c" type="string" column="city_name"/>', '<Variable name="t" type="int" column="temperature"/>', '</ContentProviderBinder>', "@c+' '+#t+'°'"].join('\n');
    const r = runScript(src, base, now, cols).results;
    expect(r[0].text).toBe('weather · live data');
    expect(r[4].text).toBe('Lisbon 9°');
  });
});


describe('dragging on the Try it phone', () => {
  it('writes the move into the line or block it came from', async () => {
    const { scriptLayout, moveInScript } = await import('./playground');
    const src = ['#battery_level', '<Text x="100" y="200" text="hi"/>', '<ContentProviderBinder name="b" uri="x">', '<Variable name="v" type="int" column="c"/>', '</ContentProviderBinder>', '<Group name="g_1" x="10" y="20">', '    <Text x="5" y="#h/2"/>', '</Group>'].join('\n');
    const { results, units } = runScript(src, base, now);
    const { pieces } = scriptLayout(src, results, units);
    expect(pieces.map((p) => p.kind)).toEqual(['line', 'line', 'block']);
    // A formula line becomes the Text it draws, at its new spot.
    expect(moveInScript(src, pieces[0], 0, 0, 40).split('\n')[0]).toBe('<Text x="540" y="300" align="center" size="48" color="#ffffffff" textExp="#battery_level"/>');
    expect(moveInScript(src, pieces[1], 0, -20, 0).split('\n')[1]).toBe('<Text x="80" y="200" text="hi" size="48" color="#ffffffff"/>');
    // Inside a block: only that element, past the data source, formulas kept.
    const moved = moveInScript(src, pieces[2], 1, 10, -6).split('\n');
    expect(moved[5]).toBe('<Group name="g_1" x="10" y="20">');
    expect(moved[6]).toBe('    <Text x="15" y="#h/2-6"/>');
  });
});
