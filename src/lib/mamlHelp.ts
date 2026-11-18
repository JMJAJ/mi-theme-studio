// What the formula fields in the lock screen editor know: the phone's variables
// with a plain description, the functions, ready-made snippets, and the
// mistakes worth pointing out while typing.

import type { Vars } from './maml';

/** The phone's own variables (and the binders the editor adds), described for the autocomplete. */
export const VAR_INFO: Record<string, string> = {
  hour24: 'Hour 0–23',
  hour12: 'Hour 1–12',
  minute: 'Minute 0–59',
  second: 'Second 0–59',
  ampm: '0 = AM, 1 = PM',
  year: 'Year',
  month: 'Month 0–11 (January = 0)',
  month1: 'Month 1–12',
  date: 'Day of month',
  day_of_week: '1 = Sunday … 7 = Saturday',
  time: 'Now, in milliseconds (for formatDate)',
  time_format: '1 = 24-hour, 0 = 12-hour (phone setting)',
  battery_level: 'Battery 0–100',
  battery_state: '0 normal · 1 charging · 2 low · 3 full',
  screen_width: 'Layout width',
  screen_height: 'Layout height',
  sms_unread_count: 'Unread messages',
  call_missed_count: 'Missed calls',
  music_state: '1 while music plays',
  next_alarm_time: 'Next alarm as text',
  frame_rate: 'Drawing rate',
  touch_x: 'Last touch x',
  touch_y: 'Last touch y',
  mts_weather_city: 'Weather: city',
  mts_weather_desc: 'Weather: condition in words',
  mts_weather_temp: 'Weather: temperature number',
  mts_weather_range: 'Weather: today’s low~high',
  mts_weather_type: 'Weather: condition number (for icons)',
  mts_has_weather: '1 once weather data arrived',
  mts_steps: 'Steps today',
  mts_steps_goal: 'Step goal',
  mts_has_steps: '1 once step data arrived',
};

export interface FuncInfo {
  name: string;
  /** What gets inserted, with the caret after the opening bracket. */
  insert: string;
  sig: string;
  desc: string;
}

export const FUNC_INFO: FuncInfo[] = [
  { name: 'ifelse', insert: 'ifelse(', sig: 'ifelse(condition, then, otherwise)', desc: 'Pick a value by a condition' },
  { name: 'eq', insert: 'eq(', sig: 'eq(a, b)', desc: '1 when equal' },
  { name: 'ne', insert: 'ne(', sig: 'ne(a, b)', desc: '1 when different' },
  { name: 'not', insert: 'not(', sig: 'not(x)', desc: '1 when x is 0' },
  { name: 'min', insert: 'min(', sig: 'min(a, b, …)', desc: 'Smallest' },
  { name: 'max', insert: 'max(', sig: 'max(a, b, …)', desc: 'Largest' },
  { name: 'int', insert: 'int(', sig: 'int(x)', desc: 'Whole part' },
  { name: 'round', insert: 'round(', sig: 'round(x)', desc: 'Nearest whole number' },
  { name: 'abs', insert: 'abs(', sig: 'abs(x)', desc: 'Without sign' },
  { name: 'digit', insert: 'digit(', sig: 'digit(n, i)', desc: 'i-th digit from the right' },
  { name: 'formatDate', insert: "formatDate('", sig: "formatDate('d/M EE', #time)", desc: 'A date as text' },
  { name: 'strToUpperCase', insert: 'strToUpperCase(', sig: 'strToUpperCase(text)', desc: 'UPPER CASE' },
  { name: 'strToLowerCase', insert: 'strToLowerCase(', sig: 'strToLowerCase(text)', desc: 'lower case' },
  { name: 'substr', insert: 'substr(', sig: 'substr(text, start, count)', desc: 'Part of a text' },
  { name: 'len', insert: 'len(', sig: 'len(text)', desc: 'Number of characters' },
  { name: 'strContains', insert: 'strContains(', sig: 'strContains(text, part)', desc: '1 if part is in text' },
  { name: 'strIsEmpty', insert: 'strIsEmpty(', sig: 'strIsEmpty(text)', desc: '1 if empty' },
];

export interface Snippet {
  title: string;
  desc: string;
  code: string;
  /** Which fields it suits. */
  kind: 'text' | 'number' | 'visibility';
}

export const SNIPPETS: Snippet[] = [
  { title: 'Join text', desc: 'Words in single quotes, joined with +', code: "formatDate('EEEE',#time)+' · '+#battery_level+'%'", kind: 'text' },
  { title: 'Battery percent', desc: 'A number joined to text becomes text', code: "#battery_level+'%'", kind: 'text' },
  { title: 'Greeting by hour', desc: 'ifelse(condition, then, otherwise)', code: "ifelse(#hour24{12,'Good morning',#hour24{18,'Good afternoon','Good evening')", kind: 'text' },
  { title: 'Charging or percent', desc: 'Text that follows the battery state', code: "ifelse(eq(#battery_state,1),'Charging',#battery_level+'%')", kind: 'text' },
  { title: 'A date in text', desc: 'formatDate(pattern, #time)', code: "formatDate('d/M EE',#time)", kind: 'text' },
  { title: 'Unread messages', desc: 'A count, or words when there are none', code: "ifelse(#sms_unread_count}0,#sms_unread_count+' new','No messages')", kind: 'text' },
  { title: 'Only while charging', desc: 'Shown when the result is more than 0', code: 'eq(#battery_state,1)', kind: 'visibility' },
  { title: 'Charging or full', desc: 'Adding two conditions = or', code: 'eq(#battery_state,1)+eq(#battery_state,3)', kind: 'visibility' },
  { title: 'Low battery', desc: '{ means less than', code: '#battery_level{20', kind: 'visibility' },
  { title: 'Daytime only', desc: '} means more than, ** means and', code: '#hour24}=6**#hour24{18', kind: 'visibility' },
  { title: 'Night only', desc: '|| means or', code: '#hour24{6||#hour24}=18', kind: 'visibility' },
  { title: 'Fill with the battery', desc: 'A width or sweep that follows the level', code: '840*#battery_level/100', kind: 'number' },
  { title: 'Centre of the screen', desc: 'Use with align="center"', code: '#screen_width/2', kind: 'number' },
  { title: 'Dimmer at night', desc: 'An opacity by the hour', code: 'ifelse(#hour24}=20,150,255)', kind: 'number' },
];

/** Date patterns offered in the Format picker. */
export const DATE_PATTERNS: [string, string][] = [
  ['HH:mm', '24-hour'],
  ['h:mm a', '12-hour'],
  ['HH:mm:ss', 'with seconds'],
  ['d/M EE', 'day/month weekday'],
  ['d/M', 'day/month'],
  ['M/d', 'month/day'],
  ['EEEE', 'weekday'],
  ['EEE, d MMM', 'short date'],
  ['d MMMM yyyy', 'long date'],
  ['yyyy-MM-dd', 'ISO date'],
];

/** Things worth pointing out in a formula while it is typed. */
export function formulaProblems(code: string, vars: Vars): string[] {
  const out: string[] = [];
  const outsideQuotes = code.replace(/'[^']*'?/g, "''");
  if (/[<>]/.test(outsideQuotes)) out.push('Write { for less than and } for greater than ( < and > break the XML).');
  if (/&&/.test(outsideQuotes)) out.push('Write ** for “and”.');
  if (/"/.test(code)) out.push('Use single quotes for words inside a formula.');
  if ((code.match(/'/g)?.length ?? 0) % 2) out.push('A quote is not closed.');
  let depth = 0;
  for (const c of outsideQuotes) depth += c === '(' ? 1 : c === ')' ? -1 : 0;
  if (depth > 0) out.push('A bracket is not closed.');
  if (depth < 0) out.push('There is an extra closing bracket.');
  for (const m of outsideQuotes.matchAll(/([#@])([A-Za-z_][\w.]*)/g)) {
    const name = m[2];
    if (!vars.has(name) && !(name in VAR_INFO)) {
      out.push(`${m[0]} isn’t a variable in this layout, so it reads as ${m[1] === '#' ? '0' : 'empty text'}.`);
      break;
    }
    const v = vars.get(name);
    if (m[1] === '#' && typeof v === 'string' && v !== '' && Number.isNaN(Number(v))) {
      out.push(`${m[0]} holds text (“${v}”); read it with @${name}.`);
      break;
    }
  }
  return out;
}

/** The variable or function name being typed at the caret, if any. */
export function tokenAt(code: string, caret: number): { kind: 'var' | 'fn'; sigil: string; prefix: string; start: number } | null {
  const before = code.slice(0, caret);
  if (((before.match(/'/g)?.length ?? 0) % 2) === 1) return null;
  const v = /([#@])([\w.]*)$/.exec(before);
  if (v) return { kind: 'var', sigil: v[1], prefix: v[2], start: caret - v[0].length };
  const f = /(?:^|[^\w#@.])([A-Za-z]\w*)$/.exec(before);
  if (f && f[1].length >= 2) return { kind: 'fn', sigil: '', prefix: f[1], start: caret - f[1].length };
  return null;
}
