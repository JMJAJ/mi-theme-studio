import { describe, expect, it } from 'vitest';
import { evalNumber, evalString, formatDate, systemVars } from './maml';
import { insertBlock } from './mamlBlocks';
import { RECIPES, recipeCode } from './mamlRecipes';

const now = new Date(2026, 2, 17, 21, 5, 7);
const vars = systemVars(1080, 2400, now);
vars.set('mts_weather_desc', 'Clear');
vars.set('mts_weather_temp', 18);
vars.set('mts_weather_city', 'Lisbon');

const recipe = (id: string) => RECIPES.find((r) => r.id === id)!;
const attrOf = (xml: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&quot;/g, '"') : null;
};

describe('recipes', () => {
  it.each(RECIPES.map((r) => [r.id, r] as const))('%s makes balanced, named XML', (_id, r) => {
    const code = recipeCode(r, r.defaults);
    expect(code).not.toContain('{x}');
    expect(code).toContain(`name="${r.id}_1"`);
    const tags = code.replace(/<!--[\s\S]*?-->/g, '');
    const opens = (tags.match(/<[A-Z]\w*[^>]*[^/]>/g) ?? []).length;
    const closes = (tags.match(/<\/[A-Z]\w*>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('builds the date pattern', () => {
    const r = recipe('date');
    expect(formatDate(attrOf(recipeCode(r, r.defaults), 'format')!, now)).toBe('17/3 Tue');
    expect(formatDate(attrOf(recipeCode(r, { ...r.defaults, weekday: 'EEEE', weekdayFirst: true, sep: ', ', order: 'd MMMM' }), 'format')!, now)).toBe('Tuesday, 17 March');
  });

  it('joins the weather parts', () => {
    const r = recipe('wline');
    expect(evalString(attrOf(recipeCode(r, r.defaults), 'textExp'), vars)).toBe('Clear 18°');
    expect(evalString(attrOf(recipeCode(r, { ...r.defaults, city: true, sep: ' · ' }), 'textExp'), vars)).toBe('Lisbon · Clear · 18°');
  });

  it('keeps typed words safe', () => {
    const r = recipe('greeting');
    const code = recipeCode(r, { ...r.defaults, evening: `Night's "here" <3 & more` });
    const expr = attrOf(code, 'textExp')!;
    expect(evalString(expr, vars)).toBe('Night’s "here" <3 & more');
  });

  it('shows the low battery warning only below the level', () => {
    const r = recipe('lowbat');
    const vis = /<Group[^>]*visibility="([^"]*)"/.exec(recipeCode(r, r.defaults))![1];
    vars.set('battery_level', 15);
    expect(evalNumber(vis, vars)).toBe(1);
    vars.set('battery_level', 82);
    expect(evalNumber(vis, vars)).toBe(0);
  });

  it('inserts like a built-in widget, binder included', () => {
    const text = '<Lockscreen version="1" screenWidth="1080">\n    <Wallpaper/>\n</Lockscreen>\n';
    const r = recipe('wline');
    const done = insertBlock(text, r.block(r.defaults), 0, 1080, 700)!;
    expect(done.text).toContain('<ContentProviderBinder name="mts_weather"');
    expect(done.text).toContain('<Group name="wline_1"');
  });

  it('works out the new widgets', () => {
    const code = (id: string) => recipeCode(recipe(id), recipe(id).defaults);
    // Tuesday 17 March 2026, 21:05:07: Tuesday is the 2nd day of a Monday week.
    const circle = /_today" x="([^"]*)"/.exec(code('weekstrip'))![1];
    expect(evalNumber(circle, vars)).toBe(180);
    expect(evalNumber(/_hour"[^>]*rotation="([^"]*)"/.exec(code('analog'))![1], vars)).toBe(272.5);
    expect(evalString(attrOf(code('daybar'), 'textExp'), vars)).toBe('87% of today');
    expect(evalString(attrOf(code('quote'), 'textExp'), vars)).toBe('Stay curious');
    vars.set('battery_state', 3);
    expect(evalString(attrOf(code('chargeline'), 'textExp'), vars)).toBe('Fully charged');
    vars.set('battery_state', 1);
    expect(evalString(attrOf(code('chargeline'), 'textExp'), vars)).toBe('Charging · 82%');
    vars.set('battery_state', 0);
  });

  it('scales pivots and radii on other screen widths', () => {
    const r = recipe('analog');
    const done = insertBlock('<Lockscreen screenWidth="720">\n</Lockscreen>\n', r.block(r.defaults), 0, 720, 600)!;
    expect(done.text).toMatch(/_pin" x="173" y="173" r="11"/);
    expect(done.text).toMatch(/_hour" x="167" y="83" w="12" h="90" cornerRadius="6" pivotX="6" pivotY="90"/);
  });
});


describe('overlayLockscreen', () => {
  it('lays a script over a theme, binders joined once', async () => {
    const { overlayLockscreen } = await import('./mamlBlocks');
    const theme = '<Lockscreen version="1" screenWidth="1080">\n    <VariableBinders>\n        <ContentProviderBinder name="mts_weather" uri="x"></ContentProviderBinder>\n    </VariableBinders>\n    <Wallpaper/>\n</Lockscreen>\n';
    const extra = '<Lockscreen version="1" screenWidth="1080">\n<VariableBinders>\n<ContentProviderBinder name="mts_weather" uri="x"></ContentProviderBinder>\n<ContentProviderBinder name="mts_steps" uri="y"></ContentProviderBinder>\n</VariableBinders>\n<Text x="540" y="260" text="hi"/>\n</Lockscreen>';
    const out = overlayLockscreen(theme, extra);
    expect(out.match(/name="mts_weather"/g)).toHaveLength(1);
    expect(out).toContain('name="mts_steps"');
    expect(out.indexOf('<Text')).toBeGreaterThan(out.indexOf('<Wallpaper/>'));
    expect(out.match(/<VariableBinders>/g)).toHaveLength(1);
    expect(out.indexOf('</VariableBinders>')).toBeLessThan(out.indexOf('<Wallpaper/>'));
  });
});

describe('dragging on the try-out phones', () => {
  it('shifts only the dragged pieces, formulas kept', async () => {
    const { applyMoves } = await import('../components/views/PhoneMoves');
    const xml = '<Lockscreen screenWidth="1080">\n<Text x="540" y="200"/>\n<Group name="date_1" x="#screen_width/2" y="900"><Text x="0"/></Group>\n</Lockscreen>';
    const out = applyMoves(xml, { 1: [10, -20], 2: [-30, 5] });
    expect(out).toContain('<Text x="550" y="180"/>');
    expect(out).toContain('<Group name="date_1" x="#screen_width/2-30" y="905">');
    expect(out).toContain('<Text x="0"/>');
  });

  it('adds a widget where it was dropped', () => {
    const r = recipe('date');
    const done = insertBlock('<Lockscreen screenWidth="1080">\n</Lockscreen>\n', r.block(r.defaults), 0, 1080, 900, 50)!;
    expect(done.text).toMatch(/name="date_1" x="50" y="900"/);
  });
});
