// The Guide's recipe gallery: lock screen widgets you set up with plain controls
// (order, colour, words…). Each recipe turns its settings into a LockBlock, so
// it is drawn by the real preview and inserted exactly like a built-in widget.

import { LOCK_BLOCKS, WEATHER_BINDER, type LockBlock } from './mamlBlocks';

export type ParamValue = string | number | boolean;
export type Params = Record<string, ParamValue>;

export type Param =
  | { key: string; label: string; type: 'choice'; options: [string, string][] }
  | { key: string; label: string; type: 'toggle' }
  | { key: string; label: string; type: 'range'; min: number; max: number; step?: number }
  | { key: string; label: string; type: 'text'; placeholder?: string }
  | { key: string; label: string; type: 'color' };

export interface Recipe {
  id: string;
  category: 'Time & date' | 'Weather' | 'Battery' | 'Messages' | 'Text';
  title: string;
  hint: string;
  /** Extra words for search. */
  keywords: string;
  params: Param[];
  defaults: Params;
  block: (p: Params) => LockBlock;
}

export const RECIPE_COLORS: [string, string][] = [
  ['#ffffffff', 'White'],
  ['#ccffffff', 'Soft white'],
  ['#ffa8e6ff', 'Ice'],
  ['#ffffd27a', 'Sun'],
  ['#ffff8a80', 'Coral'],
  ['#ffb9f6ca', 'Mint'],
];

/** Words typed by the user, made safe inside a formula's '…' and an XML attribute. */
export const quoted = (s: string) => `'${s.replace(/'/g, '’').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}'`;
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const n = (v: ParamValue) => Math.round(Number(v));
const s = (v: ParamValue) => String(v);

const SEPARATORS: [string, string][] = [
  [' ', 'space'],
  [' · ', '·'],
  [', ', ','],
  ['  ', 'wide'],
];

function datePattern(p: Params) {
  const wd = s(p.weekday);
  if (wd === 'none') return s(p.order);
  return p.weekdayFirst ? `${wd}${s(p.sep)}${s(p.order)}` : `${s(p.order)}${s(p.sep)}${wd}`;
}

export const RECIPES: Recipe[] = [
  {
    id: 'date',
    category: 'Time & date',
    title: 'Date line',
    hint: 'd/M EE, 3/17 Tue, Tue 17 Mar…',
    keywords: 'day month weekday format datetime',
    params: [
      { key: 'order', label: 'Order', type: 'choice', options: [['d/M', '17/3'], ['M/d', '3/17'], ['dd.MM', '17.03'], ['d MMM', '17 Mar'], ['d MMMM', '17 March']] },
      { key: 'weekday', label: 'Weekday', type: 'choice', options: [['none', 'None'], ['EE', 'Tue'], ['EEEE', 'Tuesday']] },
      { key: 'weekdayFirst', label: 'Weekday first', type: 'toggle' },
      { key: 'sep', label: 'Between', type: 'choice', options: SEPARATORS },
      { key: 'size', label: 'Size', type: 'range', min: 30, max: 100 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { order: 'd/M', weekday: 'EE', weekdayFirst: false, sep: ' ', size: 54, color: '#ccffffff' },
    block: (p) => {
      const h = Math.round(n(p.size) * 1.4);
      return {
        id: 'date',
        label: 'Date line',
        hint: '',
        w: 840,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="${h}">
    <DateTime name="${name}_text" x="420" y="0" align="center" size="${n(p.size)}" color="${s(p.color)}" format="${attr(datePattern(p))}"/>
</Group>`,
      };
    },
  },
  {
    id: 'clock',
    category: 'Time & date',
    title: 'Big clock',
    hint: '24-hour, 12-hour or the phone’s setting',
    keywords: 'time hour minute HH:mm 12h 24h seconds',
    params: [
      { key: 'style', label: 'Hours', type: 'choice', options: [['24', '24-hour'], ['12', '12-hour'], ['phone', 'Follow the phone']] },
      { key: 'seconds', label: 'Seconds', type: 'toggle' },
      { key: 'bold', label: 'Bold', type: 'toggle' },
      { key: 'size', label: 'Size', type: 'range', min: 120, max: 320 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { style: '24', seconds: false, bold: false, size: 230, color: '#ffffffff' },
    block: (p) => {
      const sec = p.seconds ? ':ss' : '';
      const h = Math.round(n(p.size) * 1.25);
      const fmt = p.style === 'phone' ? `formatExp="ifelse(#time_format,'HH:mm${sec}','h:mm${sec}')"` : `format="${p.style === '12' ? 'h' : 'HH'}:mm${sec}"`;
      return {
        id: 'clock',
        label: 'Big clock',
        hint: '',
        w: 1000,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="1000" h="${h}">
    <DateTime name="${name}_time" x="500" y="0" align="center" size="${n(p.size)}"${p.bold ? ' bold="true"' : ''} color="${s(p.color)}" ${fmt}/>
</Group>`,
      };
    },
  },
  {
    id: 'wline',
    category: 'Weather',
    title: 'Weather line',
    hint: 'Clear 18° · city, condition, temperature',
    keywords: 'temperature description city forecast',
    params: [
      { key: 'city', label: 'City', type: 'toggle' },
      { key: 'desc', label: 'Condition', type: 'toggle' },
      { key: 'temp', label: 'Temperature', type: 'toggle' },
      { key: 'sep', label: 'Between', type: 'choice', options: SEPARATORS },
      { key: 'size', label: 'Size', type: 'range', min: 28, max: 80 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { city: false, desc: true, temp: true, sep: ' ', size: 46, color: '#ccffffff' },
    block: (p) => {
      const parts = [p.city && '@mts_weather_city', p.desc && '@mts_weather_desc', p.temp && "#mts_weather_temp+'°'"].filter(Boolean) as string[];
      const expr = parts.length ? parts.join(`+${quoted(s(p.sep))}+`) : "''";
      const h = Math.round(n(p.size) * 1.4);
      return {
        id: 'wline',
        label: 'Weather line',
        hint: '',
        binder: { name: 'mts_weather', xml: WEATHER_BINDER },
        w: 840,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="${h}" visibility="#mts_has_weather">
    <Text name="${name}_text" x="420" y="0" align="center" size="${n(p.size)}" color="${s(p.color)}" textExp="${expr}"/>
</Group>`,
      };
    },
  },
  {
    id: 'greeting',
    category: 'Text',
    title: 'Greeting by time of day',
    hint: 'Good morning / afternoon / evening',
    keywords: 'hello hour ifelse name message',
    params: [
      { key: 'morning', label: 'Before 12:00', type: 'text' },
      { key: 'afternoon', label: '12:00 – 18:00', type: 'text' },
      { key: 'evening', label: 'After 18:00', type: 'text' },
      { key: 'bold', label: 'Bold', type: 'toggle' },
      { key: 'size', label: 'Size', type: 'range', min: 30, max: 100 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', bold: true, size: 60, color: '#ffffd27a' },
    block: (p) => {
      const h = Math.round(n(p.size) * 1.4);
      const expr = `ifelse(#hour24{12,${quoted(s(p.morning))},#hour24{18,${quoted(s(p.afternoon))},${quoted(s(p.evening))})`;
      return {
        id: 'greeting',
        label: 'Greeting',
        hint: '',
        w: 840,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="${h}">
    <Text name="${name}_text" x="420" y="0" align="center" size="${n(p.size)}"${p.bold ? ' bold="true"' : ''} color="${s(p.color)}" textExp="${expr}"/>
</Group>`,
      };
    },
  },
  {
    id: 'bbar',
    category: 'Battery',
    title: 'Battery bar',
    hint: 'A bar as long as the battery level',
    keywords: 'power level percent progress',
    params: [
      { key: 'width', label: 'Width', type: 'range', min: 300, max: 1000, step: 10 },
      { key: 'thick', label: 'Thickness', type: 'range', min: 8, max: 60 },
      { key: 'percent', label: 'Percent under it', type: 'toggle' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { width: 840, thick: 24, percent: true, color: '#ffa8e6ff' },
    block: (p) => {
      const w = n(p.width);
      const t = n(p.thick);
      const h = t + (p.percent ? 70 : 0);
      return {
        id: 'bbar',
        label: 'Battery bar',
        hint: '',
        w,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="${w}" h="${h}">
    <Rectangle name="${name}_track" x="0" y="0" w="${w}" h="${t}" cornerRadius="${Math.round(t / 2)}" fillColor="#40ffffff"/>
    <Rectangle name="${name}_fill" x="0" y="0" w="${w}*#battery_level/100" h="${t}" cornerRadius="${Math.round(t / 2)}" fillColor="${s(p.color)}"/>${
      p.percent
        ? `
    <Text name="${name}_percent" x="${Math.round(w / 2)}" y="${t + 20}" align="center" size="40" color="#ffffffff" format="%d%%" paras="#battery_level"/>`
        : ''
    }
</Group>`,
      };
    },
  },
  {
    id: 'bring',
    category: 'Battery',
    title: 'Battery ring',
    hint: 'A ring that fills; only while charging if you like',
    keywords: 'circle arc gauge charging percent',
    params: [
      { key: 'onlyCharging', label: 'Only while charging', type: 'toggle' },
      { key: 'size', label: 'Size', type: 'range', min: 200, max: 700, step: 10 },
      { key: 'thick', label: 'Thickness', type: 'range', min: 8, max: 60 },
      { key: 'percent', label: 'Percent inside', type: 'toggle' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { onlyCharging: true, size: 420, thick: 28, percent: true, color: '#ffffffff' },
    block: (p) => {
      const d = n(p.size);
      const t = n(p.thick);
      const vis = p.onlyCharging ? ' visibility="eq(#battery_state,1)+eq(#battery_state,3)"' : '';
      return {
        id: 'bring',
        label: 'Battery ring',
        hint: '',
        w: d,
        h: d,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="${d}" h="${d}"${vis}>
    <Arc name="${name}_track" x="0" y="0" w="${d}" h="${d}" startAngle="-90" sweep="360" strokeColor="#33ffffff" weight="${t}" strokeAlign="inner"/>
    <Arc name="${name}_fill" x="0" y="0" w="${d}" h="${d}" startAngle="-90" sweep="360*#battery_level/100" strokeColor="${s(p.color)}" weight="${t}" strokeAlign="inner" cap="round"/>${
      p.percent
        ? `
    <Text name="${name}_percent" x="${Math.round(d / 2)}" y="${Math.round(d / 2)}" align="center" alignV="center" size="${Math.round(d / 4.5)}" bold="true" color="#ffffffff" format="%d%%" paras="#battery_level"/>`
        : ''
    }
</Group>`,
      };
    },
  },
  {
    id: 'lowbat',
    category: 'Battery',
    title: 'Low battery warning',
    hint: 'Appears only under a level you pick',
    keywords: 'alert charge soon visibility',
    params: [
      { key: 'below', label: 'Show below', type: 'range', min: 5, max: 50 },
      { key: 'text', label: 'Words after the percent', type: 'text' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { below: 20, text: ' · charge soon', color: '#ffff8a80' },
    block: (p) => ({
      id: 'lowbat',
      label: 'Low battery',
      hint: '',
      w: 840,
      h: 56,
      body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="56" visibility="#battery_level{${n(p.below)}">
    <Text name="${name}_text" x="420" y="0" align="center" size="38" bold="true" color="${s(p.color)}" textExp="#battery_level+'%'+${quoted(s(p.text))}"/>
</Group>`,
    }),
  },
  {
    id: 'unread',
    category: 'Messages',
    title: 'Unread messages',
    hint: '3 new, or your words when there are none',
    keywords: 'sms notification count badge',
    params: [
      { key: 'some', label: 'After the count', type: 'text' },
      { key: 'none', label: 'When there are none', type: 'text', placeholder: 'leave empty to hide' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { some: ' new messages', none: 'No messages', color: '#ccffffff' },
    block: (p) => {
      const none = s(p.none);
      const vis = none ? '' : ' visibility="#sms_unread_count}0"';
      return {
        id: 'unread',
        label: 'Unread messages',
        hint: '',
        w: 840,
        h: 56,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="56"${vis}>
    <Text name="${name}_text" x="420" y="0" align="center" size="38" color="${s(p.color)}" textExp="ifelse(#sms_unread_count}0,#sms_unread_count+${quoted(s(p.some))},${quoted(none)})"/>
</Group>`,
      };
    },
  },
  {
    id: 'alarm',
    category: 'Time & date',
    title: 'Next alarm',
    hint: 'Shown only when an alarm is set',
    keywords: 'alarm clock wake reminder',
    params: [
      { key: 'prefix', label: 'Before the time', type: 'text' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { prefix: 'Alarm ', color: '#ccffffff' },
    block: (p) => ({
      id: 'alarm',
      label: 'Next alarm',
      hint: '',
      w: 840,
      h: 56,
      body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="56" visibility="!strIsEmpty(@next_alarm_time)">
    <Text name="${name}_text" x="420" y="0" align="center" size="38" color="${s(p.color)}" textExp="${quoted(s(p.prefix))}+@next_alarm_time"/>
</Group>`,
    }),
  },
  ...LOCK_BLOCKS.filter((b) => b.id === 'weather' || b.id === 'steps').map(
    (b): Recipe => ({
      id: b.id,
      category: b.id === 'weather' ? 'Weather' : 'Text',
      title: b.id === 'weather' ? 'Weather card' : 'Step count',
      hint: b.hint,
      keywords: b.id === 'weather' ? 'city temperature range card' : 'mi fitness health walk goal',
      params: [],
      defaults: {},
      block: () => b,
    }),
  ),
];

/** Every block id the editor adds (recipes and built-in widgets), for stacking new ones below earlier ones. */
export const BLOCK_IDS = new Set([...RECIPES.map((r) => r.id), ...LOCK_BLOCKS.map((b) => b.id)]);

/** The code a recipe inserts, as it will read in manifest.xml. */
export function recipeCode(r: Recipe, p: Params) {
  const b = r.block(p);
  const body = b.body(`${b.id}_1`).replace('{x}', String(Math.round((1080 - b.w) / 2))).replace('{y}', '900');
  return b.binder ? `<!-- added to <VariableBinders> once -->\n${b.binder.xml}\n\n${body}` : body;
}
