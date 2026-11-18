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
});
