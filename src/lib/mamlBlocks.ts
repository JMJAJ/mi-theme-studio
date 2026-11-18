// Ready-made lock screen pieces that work on the phone (battery, weather, steps,
// charging), built only from shapes and text so every part can be restyled.
// Inserting one adds its data source (a ContentProviderBinder) when it needs one.

export interface LockBlock {
  id: string;
  label: string;
  hint: string;
  /** Data source it reads, added to <VariableBinders> once. */
  binder?: { name: string; xml: string };
  /** Size in a 1080-wide layout. */
  w: number;
  h: number;
  body: (name: string) => string;
}

export const WEATHER_BINDER = `<ContentProviderBinder name="mts_weather" uri="content://weather/actualWeatherData/1" columns="city_name,weather_type,description,temperature,temperature_range" countName="mts_has_weather">
    <Variable name="mts_weather_city" type="string" column="city_name"/>
    <Variable name="mts_weather_type" type="int" column="weather_type"/>
    <Variable name="mts_weather_desc" type="string" column="description"/>
    <Variable name="mts_weather_temp" type="int" column="temperature"/>
    <Variable name="mts_weather_range" type="string" column="temperature_range"/>
</ContentProviderBinder>`;

// Mi Fitness / Mi Health step count (the app has to be installed on the phone).
export const STEPS_BINDER = `<ContentProviderBinder name="mts_steps" uri="content://com.mi.health.provider.main/activity/steps/brief" columns="steps,goal" countName="mts_has_steps">
    <Variable name="mts_steps" type="int" column="steps"/>
    <Variable name="mts_steps_goal" type="int" column="goal"/>
</ContentProviderBinder>`;

const CHARGING = 'eq(#battery_state,1)+eq(#battery_state,3)';

export const LOCK_BLOCKS: LockBlock[] = [
  {
    id: 'battery',
    label: 'Battery bar',
    hint: 'A bar that fills with the battery level, with the percentage',
    w: 840,
    h: 90,
    body: (n) => `<Group name="${n}" x="{x}" y="{y}" w="840" h="90">
    <Rectangle name="${n}_bg" x="0" y="0" w="840" h="90" cornerRadius="45" fillColor="#33ffffff"/>
    <Text name="${n}_label" x="40" y="45" alignV="center" size="34" color="#ffffffff" text="Power"/>
    <Rectangle name="${n}_track" x="170" y="33" w="520" h="24" cornerRadius="12" fillColor="#40ffffff"/>
    <Rectangle name="${n}_fill" x="170" y="33" w="520*#battery_level/100" h="24" cornerRadius="12" fillColor="#ffa8e6ff"/>
    <Text name="${n}_percent" x="800" y="45" align="right" alignV="center" size="34" color="#ffffffff" format="%d%%" paras="#battery_level"/>
</Group>`,
  },
  {
    id: 'weather',
    label: 'Weather',
    hint: 'City, temperature and today’s range from the Weather app',
    binder: { name: 'mts_weather', xml: WEATHER_BINDER },
    w: 440,
    h: 300,
    body: (n) => `<Group name="${n}" x="{x}" y="{y}" w="440" h="300">
    <Rectangle name="${n}_bg" x="0" y="0" w="440" h="300" cornerRadius="36" fillColor="#33ffffff"/>
    <Text name="${n}_city" x="36" y="36" size="34" color="#ccffffff" textExp="@mts_weather_city"/>
    <Text name="${n}_temp" x="36" y="96" size="96" bold="true" color="#ffffffff" format="%d°" paras="#mts_weather_temp"/>
    <Text name="${n}_range" x="36" y="226" size="34" color="#ffffffff" textExp="@mts_weather_desc+'  '+@mts_weather_range"/>
</Group>`,
  },
  {
    id: 'steps',
    label: 'Step count',
    hint: 'Today’s steps and progress to the goal, from Mi Fitness',
    binder: { name: 'mts_steps', xml: STEPS_BINDER },
    w: 440,
    h: 300,
    body: (n) => `<Group name="${n}" x="{x}" y="{y}" w="440" h="300">
    <Rectangle name="${n}_bg" x="0" y="0" w="440" h="300" cornerRadius="36" fillColor="#33ffffff"/>
    <Text name="${n}_label" x="36" y="36" size="34" color="#ccffffff" text="Steps"/>
    <Text name="${n}_count" x="36" y="96" size="96" bold="true" color="#ffffffff" format="%d" paras="#mts_steps"/>
    <Rectangle name="${n}_track" x="36" y="240" w="368" h="20" cornerRadius="10" fillColor="#40ffffff"/>
    <Rectangle name="${n}_fill" x="36" y="240" w="368*min(#mts_steps/max(#mts_steps_goal,1),1)" h="20" cornerRadius="10" fillColor="#ffa8f0c0"/>
</Group>`,
  },
  {
    id: 'charging',
    label: 'Charging ring',
    hint: 'A ring that fills with the battery level, shown only while charging',
    w: 520,
    h: 520,
    body: (n) => `<Group name="${n}" x="{x}" y="{y}" w="520" h="520" visibility="${CHARGING}">
    <Arc name="${n}_track" x="0" y="0" w="520" h="520" startAngle="-90" sweep="360" strokeColor="#33ffffff" weight="28" strokeAlign="inner"/>
    <Arc name="${n}_fill" x="0" y="0" w="520" h="520" startAngle="-90" sweep="360*#battery_level/100" strokeColor="#ffffffff" weight="28" strokeAlign="inner" cap="round"/>
    <Text name="${n}_percent" x="260" y="240" align="center" alignV="center" size="120" bold="true" color="#ffffffff" format="%d%%" paras="#battery_level"/>
    <Text name="${n}_state" x="260" y="340" align="center" alignV="center" size="36" color="#ccffffff" text="Charging" visibility="eq(#battery_state,1)"/>
    <Text name="${n}_full" x="260" y="340" align="center" alignV="center" size="36" color="#ccffffff" text="Fully charged" visibility="eq(#battery_state,3)"/>
</Group>`,
  },
];

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/[^>]*>|<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** Where the end tag of the element with this document-order index starts. */
function closeTagOf(text: string, ordinal: number): number | null {
  TOKEN.lastIndex = 0;
  let n = 0;
  let depth = 0;
  let found = false;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const start = m[1] !== undefined;
    const selfClosing = start && /\/\s*>$/.test(m[0]);
    if (!found) {
      if (!start) continue;
      if (n++ !== ordinal) continue;
      if (selfClosing) return null;
      found = true;
      depth = 1;
      continue;
    }
    if (start && !selfClosing) depth++;
    else if (m[0].startsWith('</') && --depth === 0) return m.index;
  }
  return null;
}

/** Document-order index of the element whose start tag begins at this offset. */
function ordinalAt(text: string, offset: number) {
  TOKEN.lastIndex = 0;
  let n = 0;
  for (let m = TOKEN.exec(text); m && m.index < offset; m = TOKEN.exec(text)) if (m[1] !== undefined) n++;
  return n;
}

const indentOf = (text: string, offset: number) => /[ \t]*$/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset))?.[0] ?? '';
const reindent = (xml: string, pad: string) => xml.split('\n').map((l) => pad + l).join('\n');

/** Insert XML as the last child of the element `target` (document-order index). `start` is where it begins. */
export function insertInto(text: string, target: number, xml: string): { text: string; start: number } | null {
  const close = closeTagOf(text, target);
  if (close === null) return null;
  const closeIndent = indentOf(text, close);
  const pad = closeIndent + '    ';
  const lineStart = text.lastIndexOf('\n', close - 1) + 1;
  if (!text.slice(lineStart, close).trim()) return { text: text.slice(0, lineStart) + reindent(xml, pad) + '\n' + text.slice(lineStart), start: lineStart + pad.length };
  return { text: text.slice(0, close) + '\n' + reindent(xml, pad) + '\n' + closeIndent + text.slice(close), start: close + 1 + pad.length };
}

/** Add data sources to <VariableBinders> (made right after the root's start tag when missing). `at` is where they went. */
export function addBinders(text: string, binders: string[]): { text: string; at: number } | null {
  if (!binders.length) return { text, at: text.length };
  const xml = binders.join('\n');
  const end = text.indexOf('</VariableBinders>');
  if (end !== -1) {
    const ls = text.lastIndexOf('\n', end - 1) + 1;
    const ind = indentOf(text, end);
    return !text.slice(ls, end).trim() ? { text: text.slice(0, ls) + reindent(xml, ind + '    ') + '\n' + text.slice(ls), at: ls } : { text: text.slice(0, end) + xml + text.slice(end), at: end };
  }
  TOKEN.lastIndex = 0;
  let root: RegExpExecArray | null = null;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text))
    if (m[1] !== undefined) {
      root = m;
      break;
    }
  if (!root) return null;
  const at = root.index + root[0].length;
  return { text: text.slice(0, at) + '\n' + reindent(`<VariableBinders>\n${reindent(xml, '    ')}\n</VariableBinders>`, '    ') + text.slice(at), at };
}

/**
 * Put a block inside the element `target` (a page's group, or the root at 0),
 * centred across `width` at height `y`. Returns the new text and the block's ordinal.
 */
export function insertBlock(text: string, block: LockBlock, target: number, width: number, y: number): { text: string; ord: number } | null {
  let n = 1;
  while (new RegExp(`name="${block.id}_${n}"`).test(text)) n++;
  const name = `${block.id}_${n}`;
  const k = width / 1080;
  const scaled = block.body(name).replace(/\b(x|y|w|h|r|size|cornerRadius|weight|pivotX|pivotY)="(\d+(?:\.\d+)?)"/g, (_m, a: string, v: string) => `${a}="${Math.round(Number(v) * k)}"`);
  const body = scaled.replace('{x}', String(Math.round((width - block.w * k) / 2))).replace('{y}', String(Math.round(y)));
  // Literal sizes inside formulas (520*#battery_level) scale too.
  const sized = k === 1 ? body : body.replace(/="(\d+)\*/g, (_m, v: string) => `="${Math.round(Number(v) * k)}*`);
  const placed = insertInto(text, target, sized);
  if (!placed) return null;
  let out = placed.text;
  if (block.binder && !new RegExp(`<ContentProviderBinder[^>]*name="${block.binder.name}"`).test(out)) {
    const added = addBinders(out, [block.binder.xml]);
    if (!added) return null;
    out = added.text;
  }
  const ord = ordinalAt(out, out.indexOf(`<Group name="${name}"`));
  return { text: out, ord };
}

/** The biggest group shown only on this page of a multi-page lock screen (where its pieces go). */
export function pageGroupOrdinal(elements: Element[], name: string, value: number): number | null {
  const re = new RegExp(`eq\\(\\s*#${name.replace(/\./g, '\\.')}\\s*,\\s*${value}\\s*\\)|#${name.replace(/\./g, '\\.')}\\s*==\\s*${value}(?!\\d)`);
  let best: number | null = null;
  let bestSize = 0;
  elements.forEach((el, i) => {
    if (el.tagName !== 'Group' || !re.test(el.getAttribute('visibility') ?? '')) return;
    const size = el.getElementsByTagName('*').length;
    if (size > bestSize) {
      best = i;
      bestSize = size;
    }
  });
  return best;
}
