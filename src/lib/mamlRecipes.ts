// The Guide's recipe gallery: lock screen widgets you set up with plain controls
// (order, colour, words…). Each recipe turns its settings into a LockBlock, so
// it is drawn by the real preview and inserted exactly like a built-in widget.

import { BASIC_BLOCKS, LOCK_BLOCKS, STEPS_BINDER, WEATHER_BINDER, type LockBlock } from './mamlBlocks';

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
  category: 'Time & date' | 'Weather' | 'Battery' | 'Messages' | 'Health' | 'Text';
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
  {
    id: 'stacked',
    category: 'Time & date',
    title: 'Stacked clock',
    hint: 'Hours above minutes, big and bold',
    keywords: 'time hour minute big two lines',
    params: [
      { key: 'style', label: 'Hours', type: 'choice', options: [['24', '24-hour'], ['12', '12-hour']] },
      { key: 'size', label: 'Size', type: 'range', min: 140, max: 360 },
      { key: 'bold', label: 'Bold', type: 'toggle' },
      { key: 'hourColor', label: 'Hours colour', type: 'color' },
      { key: 'minColor', label: 'Minutes colour', type: 'color' },
    ],
    defaults: { style: '24', size: 260, bold: true, hourColor: '#ffffffff', minColor: '#ffffd27a' },
    block: (p) => {
      const size = n(p.size);
      const line = Math.round(size * 0.92);
      const h = line * 2 + Math.round(size * 0.2);
      const b = p.bold ? ' bold="true"' : '';
      return {
        id: 'stacked',
        label: 'Stacked clock',
        hint: '',
        w: 700,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="700" h="${h}">
    <DateTime name="${name}_hour" x="350" y="0" align="center" size="${size}"${b} color="${s(p.hourColor)}" format="${p.style === '12' ? 'hh' : 'HH'}"/>
    <DateTime name="${name}_min" x="350" y="${line}" align="center" size="${size}"${b} color="${s(p.minColor)}" format="mm"/>
</Group>`,
      };
    },
  },
  {
    id: 'analog',
    category: 'Time & date',
    title: 'Analog clock',
    hint: 'A face and hands made of shapes, turning with the time',
    keywords: 'hands dial watch rotation pivot',
    params: [
      { key: 'size', label: 'Size', type: 'range', min: 300, max: 800, step: 10 },
      { key: 'seconds', label: 'Second hand', type: 'toggle' },
      { key: 'face', label: 'Face', type: 'toggle' },
      { key: 'color', label: 'Hands colour', type: 'color' },
    ],
    defaults: { size: 520, seconds: true, face: true, color: '#ffffffff' },
    block: (p) => {
      const d = n(p.size);
      const c = Math.round(d / 2);
      const hand = (part: string, len: number, w: number, rot: string, color: string) =>
        `    <Rectangle name="${'{n}'}_${part}" x="${c - Math.round(w / 2)}" y="${c - len}" w="${w}" h="${len}" cornerRadius="${Math.round(w / 2)}" pivotX="${Math.round(w / 2)}" pivotY="${len}" fillColor="${color}" rotation="${rot}"/>`;
      const ticks = [0, 90, 180, 270]
        .map((deg, i) => `    <Rectangle name="${'{n}'}_tick${i}" x="${c - 4}" y="${Math.round(d * 0.06)}" w="8" h="${Math.round(d * 0.07)}" cornerRadius="4" pivotX="4" pivotY="${c - Math.round(d * 0.06)}" fillColor="#99ffffff" rotation="${deg}"/>`)
        .join('\n');
      return {
        id: 'analog',
        label: 'Analog clock',
        hint: '',
        w: d,
        h: d,
        body: (name) =>
          `<Group name="${name}" x="{x}" y="{y}" w="${d}" h="${d}">
${p.face ? `    <Circle name="${name}_face" x="${c}" y="${c}" r="${c}" fillColor="#26ffffff"/>\n${ticks}\n` : ''}${hand('hour', Math.round(d * 0.26), Math.round(d * 0.035), '(#hour12%12)*30+#minute*0.5', s(p.color))}
${hand('minute', Math.round(d * 0.38), Math.round(d * 0.024), '#minute*6+#second*0.1', s(p.color))}${p.seconds ? `\n${hand('second', Math.round(d * 0.42), Math.max(4, Math.round(d * 0.009)), '#second*6', '#ffff8a80')}` : ''}
    <Circle name="${name}_pin" x="${c}" y="${c}" r="${Math.round(d * 0.03)}" fillColor="${s(p.color)}"/>
</Group>`.replace(/\{n\}/g, name),
      };
    },
  },
  {
    id: 'secring',
    category: 'Time & date',
    title: 'Seconds ring',
    hint: 'A ring that goes round once a minute, with the time inside',
    keywords: 'arc circle second progress',
    params: [
      { key: 'size', label: 'Size', type: 'range', min: 300, max: 800, step: 10 },
      { key: 'thick', label: 'Thickness', type: 'range', min: 6, max: 40 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { size: 480, thick: 14, color: '#ffa8e6ff' },
    block: (p) => {
      const d = n(p.size);
      const t = n(p.thick);
      return {
        id: 'secring',
        label: 'Seconds ring',
        hint: '',
        w: d,
        h: d,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="${d}" h="${d}">
    <Arc name="${name}_track" x="0" y="0" w="${d}" h="${d}" startAngle="-90" sweep="360" strokeColor="#26ffffff" weight="${t}" strokeAlign="inner"/>
    <Arc name="${name}_fill" x="0" y="0" w="${d}" h="${d}" startAngle="-90" sweep="#second*6" strokeColor="${s(p.color)}" weight="${t}" strokeAlign="inner" cap="round"/>
    <DateTime name="${name}_time" x="${Math.round(d / 2)}" y="${Math.round(d / 2)}" align="center" alignV="center" size="${Math.round(d / 4)}" color="#ffffffff" format="HH:mm"/>
</Group>`,
      };
    },
  },
  {
    id: 'calcard',
    category: 'Time & date',
    title: 'Calendar card',
    hint: 'Weekday, big day number and month on a card',
    keywords: 'date day month card tile',
    params: [
      { key: 'accent', label: 'Weekday colour', type: 'color' },
      { key: 'card', label: 'Card behind', type: 'toggle' },
    ],
    defaults: { accent: '#ffff8a80', card: true },
    block: (p) => ({
      id: 'calcard',
      label: 'Calendar card',
      hint: '',
      w: 320,
      h: 340,
      body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="320" h="340">${
        p.card
          ? `
    <Rectangle name="${name}_bg" x="0" y="0" w="320" h="340" cornerRadius="40" fillColor="#33ffffff"/>`
          : ''
      }
    <DateTime name="${name}_weekday" x="160" y="34" align="center" size="40" bold="true" color="${s(p.accent)}" format="EEEE"/>
    <DateTime name="${name}_day" x="160" y="92" align="center" size="150" bold="true" color="#ffffffff" format="d"/>
    <DateTime name="${name}_month" x="160" y="262" align="center" size="38" color="#ccffffff" format="MMMM yyyy"/>
</Group>`,
    }),
  },
  {
    id: 'weekstrip',
    category: 'Time & date',
    title: 'Week strip',
    hint: 'The days of the week with today circled',
    keywords: 'monday sunday days calendar today highlight',
    params: [
      { key: 'start', label: 'Week starts', type: 'choice', options: [['mon', 'Monday'], ['sun', 'Sunday']] },
      { key: 'color', label: 'Circle colour', type: 'color' },
    ],
    defaults: { start: 'mon', color: '#ffa8e6ff' },
    block: (p) => {
      const mon = p.start !== 'sun';
      const letters = mon ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      // #day_of_week is 1 on Sunday … 7 on Saturday; this is today's place in the strip.
      const index = mon ? '((#day_of_week+5)%7)' : '(#day_of_week-1)';
      return {
        id: 'weekstrip',
        label: 'Week strip',
        hint: '',
        w: 840,
        h: 110,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="110">
    <Circle name="${name}_today" x="120*(${index}+0.5)" y="55" r="50" fillColor="${s(p.color)}"/>
${letters.map((l, i) => `    <Text name="${name}_d${i}" x="${60 + i * 120}" y="55" align="center" alignV="center" size="40" bold="true" color="#ffffffff" text="${l}"/>`).join('\n')}
</Group>`,
      };
    },
  },
  {
    id: 'daybar',
    category: 'Time & date',
    title: 'Day progress',
    hint: 'How much of today has gone, as a bar and a percent',
    keywords: 'progress percent hours left bar',
    params: [
      { key: 'width', label: 'Width', type: 'range', min: 300, max: 1000, step: 10 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { width: 840, color: '#ffffd27a' },
    block: (p) => {
      const w = n(p.width);
      return {
        id: 'daybar',
        label: 'Day progress',
        hint: '',
        w,
        h: 100,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="${w}" h="100">
    <Text name="${name}_text" x="0" y="0" size="34" color="#ccffffff" textExp="int((#hour24*60+#minute)*100/1440)+'% of today'"/>
    <Rectangle name="${name}_track" x="0" y="64" w="${w}" h="16" cornerRadius="8" fillColor="#33ffffff"/>
    <Rectangle name="${name}_fill" x="0" y="64" w="${w}*(#hour24*60+#minute)/1440" h="16" cornerRadius="8" fillColor="${s(p.color)}"/>
</Group>`,
      };
    },
  },
  {
    id: 'bigtemp',
    category: 'Weather',
    title: 'Big temperature',
    hint: 'The temperature large, condition and today’s range under it',
    keywords: 'degrees weather large range',
    params: [
      { key: 'size', label: 'Size', type: 'range', min: 120, max: 320 },
      { key: 'range', label: 'Today’s range', type: 'toggle' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { size: 220, range: true, color: '#ffffffff' },
    block: (p) => {
      const size = n(p.size);
      const h = Math.round(size * 1.05) + (p.range ? 120 : 64);
      return {
        id: 'bigtemp',
        label: 'Big temperature',
        hint: '',
        binder: { name: 'mts_weather', xml: WEATHER_BINDER },
        w: 840,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="${h}" visibility="#mts_has_weather">
    <Text name="${name}_temp" x="420" y="0" align="center" size="${size}" color="${s(p.color)}" format="%d°" paras="#mts_weather_temp"/>
    <Text name="${name}_desc" x="420" y="${Math.round(size * 1.05)}" align="center" size="44" color="#ccffffff" textExp="@mts_weather_desc"/>${
      p.range
        ? `
    <Text name="${name}_range" x="420" y="${Math.round(size * 1.05) + 60}" align="center" size="36" color="#99ffffff" textExp="@mts_weather_range"/>`
        : ''
    }
</Group>`,
      };
    },
  },
  {
    id: 'chargeline',
    category: 'Battery',
    title: 'Charging status',
    hint: '“Charging · 64%” while plugged in, “Fully charged” when full',
    keywords: 'plugged power charger full',
    params: [
      { key: 'charging', label: 'While charging', type: 'text' },
      { key: 'full', label: 'When full', type: 'text' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { charging: 'Charging · ', full: 'Fully charged', color: '#ffb9f6ca' },
    block: (p) => ({
      id: 'chargeline',
      label: 'Charging status',
      hint: '',
      w: 840,
      h: 56,
      body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="56" visibility="eq(#battery_state,1)+eq(#battery_state,3)">
    <Text name="${name}_text" x="420" y="0" align="center" size="38" color="${s(p.color)}" textExp="ifelse(eq(#battery_state,3),${quoted(s(p.full))},${quoted(s(p.charging))}+#battery_level+'%')"/>
</Group>`,
    }),
  },
  {
    id: 'missed',
    category: 'Messages',
    title: 'Missed calls',
    hint: 'A count of missed calls, shown only when there are some',
    keywords: 'phone call missed badge count',
    params: [
      { key: 'one', label: 'Words after the count', type: 'text' },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { one: ' missed calls', color: '#ffff8a80' },
    block: (p) => ({
      id: 'missed',
      label: 'Missed calls',
      hint: '',
      w: 840,
      h: 56,
      body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="840" h="56" visibility="#call_missed_count}0">
    <Text name="${name}_text" x="420" y="0" align="center" size="38" color="${s(p.color)}" textExp="#call_missed_count+${quoted(s(p.one))}"/>
</Group>`,
    }),
  },
  {
    id: 'quote',
    category: 'Text',
    title: 'Quote of the day',
    hint: 'A different line each day, from three you write',
    keywords: 'motto saying message rotate daily',
    params: [
      { key: 'a', label: 'Line 1', type: 'text' },
      { key: 'b', label: 'Line 2', type: 'text' },
      { key: 'c', label: 'Line 3', type: 'text' },
      { key: 'size', label: 'Size', type: 'range', min: 28, max: 72 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { a: 'Make today count', b: 'One step at a time', c: 'Stay curious', size: 44, color: '#ccffffff' },
    block: (p) => {
      const h = Math.round(n(p.size) * 1.4);
      return {
        id: 'quote',
        label: 'Quote of the day',
        hint: '',
        w: 960,
        h,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="960" h="${h}">
    <Text name="${name}_text" x="480" y="0" align="center" size="${n(p.size)}" color="${s(p.color)}" textExp="ifelse(#date%3==0,${quoted(s(p.a))},#date%3==1,${quoted(s(p.b))},${quoted(s(p.c))})"/>
</Group>`,
      };
    },
  },
  {
    id: 'stepsring',
    category: 'Health',
    title: 'Steps ring',
    hint: 'A ring that fills toward your step goal, from Mi Fitness',
    keywords: 'walk goal fitness health arc',
    params: [
      { key: 'size', label: 'Size', type: 'range', min: 240, max: 640, step: 10 },
      { key: 'color', label: 'Colour', type: 'color' },
    ],
    defaults: { size: 380, color: '#ffb9f6ca' },
    block: (p) => {
      const d = n(p.size);
      const t = Math.max(10, Math.round(d * 0.07));
      return {
        id: 'stepsring',
        label: 'Steps ring',
        hint: '',
        binder: { name: 'mts_steps', xml: STEPS_BINDER },
        w: d,
        h: d,
        body: (name) => `<Group name="${name}" x="{x}" y="{y}" w="${d}" h="${d}">
    <Arc name="${name}_track" x="0" y="0" w="${d}" h="${d}" startAngle="-90" sweep="360" strokeColor="#26ffffff" weight="${t}" strokeAlign="inner"/>
    <Arc name="${name}_fill" x="0" y="0" w="${d}" h="${d}" startAngle="-90" sweep="360*min(#mts_steps/max(#mts_steps_goal,1),1)" strokeColor="${s(p.color)}" weight="${t}" strokeAlign="inner" cap="round"/>
    <Text name="${name}_count" x="${Math.round(d / 2)}" y="${Math.round(d * 0.44)}" align="center" alignV="center" size="${Math.round(d / 5)}" bold="true" color="#ffffffff" format="%d" paras="#mts_steps"/>
    <Text name="${name}_label" x="${Math.round(d / 2)}" y="${Math.round(d * 0.64)}" align="center" alignV="center" size="${Math.round(d / 13)}" color="#ccffffff" text="steps"/>
</Group>`,
      };
    },
  },
  ...LOCK_BLOCKS.filter((b) => b.id === 'weather' || b.id === 'steps').map(
    (b): Recipe => ({
      id: b.id,
      category: b.id === 'weather' ? 'Weather' : 'Health',
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
export const BLOCK_IDS = new Set([...RECIPES.map((r) => r.id), ...LOCK_BLOCKS.map((b) => b.id), ...BASIC_BLOCKS.map((b) => b.id), 'image']);

/** The code a recipe inserts, as it will read in manifest.xml. */
export function recipeCode(r: Recipe, p: Params) {
  return blockCode(r.block(p));
}

/** Where a widget goes when nothing else says: centred, at y 900 on a 1080-wide screen. */
export const defaultSpot = (b: LockBlock) => ({ x: Math.round((1080 - b.w) / 2), y: 900 });

/** The code a widget writes with its top-left corner at `at` (its data source first, when it has one). */
export function blockCode(b: LockBlock, at = defaultSpot(b)) {
  const spot: Record<string, number> = { x: at.x, y: at.y, cx: at.x + b.w / 2, x1: at.x + b.w, cy: at.y + b.h / 2 };
  const body = b.body(`${b.id}_1`).replace(/\{(x|cx|x1|y|cy)\}/g, (_m, k: string) => String(Math.round(spot[k])));
  return b.binder ? `<!-- added to <VariableBinders> once -->\n${b.binder.xml}\n\n${body}` : body;
}
