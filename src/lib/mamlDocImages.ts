// Draws the pictures in docs/maml/img/ as SVG. Every value on them (texts, bar
// widths, ring sweeps, what is shown or hidden) is worked out by the editor's
// evaluator from the same examples the guide prints. Run by mamlDocExamples.test.ts.

import { evalNumber, evalString, formatDate, formatWithParas, systemVars, type Value, type Vars } from './maml';
import { DOC_NOW, docVars, runExample, STARTER_MANIFEST, type DocExample } from './mamlDocExamples';

const SANS = 'Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';
const MONO = 'Consolas, Menlo, DejaVu Sans Mono, monospace';
const C = {
  bg: '#0f1115',
  panel: '#171a21',
  line: '#2a2f3a',
  text: '#e8eaf0',
  muted: '#8a93a6',
  accent: '#ff6a1a',
  num: '#ffb86b',
  str: '#7ee0a4',
  quote: '#9ecbff',
  fn: '#d6a6ff',
  op: '#c9d1e0',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sansW = (s: string, size: number) => [...s].length * size * 0.56;

function svg(w: number, h: number, body: string, title: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${w}" height="${h}" rx="14" fill="${C.bg}"/>
${body}
</svg>
`;
}

/** MAML code as coloured tspans: #numbers, @strings, 'quoted', functions(. */
function codeSpans(code: string): string {
  const re = /('[^']*'?)|([#@][\w.]+)|([A-Za-z_]\w*)(?=\()|(\d+(?:\.\d+)?)|(\s+)|(.)/g;
  let out = '';
  for (const m of code.matchAll(re)) {
    const [t, quoted, variable, fn, number] = m;
    const color = quoted ? C.quote : variable ? (variable[0] === '#' ? C.num : C.str) : fn ? C.fn : number ? C.num : C.op;
    out += `<tspan fill="${color}">${esc(t).replace(/ /g, '&#160;')}</tspan>`;
  }
  return out;
}

/** The code line as it sits in manifest.xml, e.g. textExp="…". */
function codeLine(e: DocExample): { prefix: string; code: string; suffix: string } {
  switch (e.kind) {
    case 'date':
      return { prefix: '<DateTime format="', code: e.code, suffix: '"/>' };
    case 'expr':
      return { prefix: '<Text textExp="', code: e.code, suffix: '"/>' };
    case 'format':
      return { prefix: '<Text format="', code: e.code, suffix: `" paras="${e.paras}"/>` };
    case 'number':
      return { prefix: `${e.attr}="`, code: e.code, suffix: '"' };
  }
}

/** A sheet of examples: the code on one line, what the phone shows under it. */
export function exampleSheet(title: string, subtitle: string, examples: DocExample[]): string {
  const W = 1000;
  const rowH = 86;
  const top = 92;
  let body = `<text x="32" y="44" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.text}">${esc(title)}</text>
<text x="32" y="70" font-family="${SANS}" font-size="14" fill="${C.muted}">${esc(subtitle)}</text>`;
  examples.forEach((e, i) => {
    const y = top + i * rowH;
    const { prefix, code, suffix } = codeLine(e);
    const result = runExample(e);
    const shown = e.kind === 'number' ? `${e.attr} = ${result}` : result;
    const pillW = Math.max(70, sansW(shown, 19) + 36);
    body += `
<rect x="20" y="${y}" width="${W - 40}" height="${rowH - 10}" rx="10" fill="${C.panel}"/>
<text x="36" y="${y + 28}" font-family="${MONO}" font-size="15"><tspan fill="${C.muted}">${esc(prefix)}</tspan>${codeSpans(code)}<tspan fill="${C.muted}">${esc(suffix)}</tspan></text>
<text x="36" y="${y + 59}" font-family="${SANS}" font-size="18" fill="${C.accent}">→</text>
<rect x="62" y="${y + 39}" width="${pillW}" height="28" rx="8" fill="#232b3d" stroke="#34405a"/>
<text x="${62 + 18}" y="${y + 59}" font-family="${SANS}" font-size="19" font-weight="600" fill="#ffffff">${esc(shown)}</text>
${e.note ? `<text x="${62 + pillW + 18}" y="${y + 59}" font-family="${SANS}" font-size="15" fill="${C.muted}">${esc(e.note)}</text>` : ''}`;
  });
  return svg(W, top + examples.length * rowH + 12, body, title);
}

// ---------- the starter lock screen ----------

interface Piece {
  tag: string;
  attrs: Record<string, string>;
}

function piecesOf(xml: string): Piece[] {
  const out: Piece[] = [];
  for (const m of xml.matchAll(/<(DateTime|Text|Rectangle)\s([^>]*?)\/>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w.]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, '&');
    out.push({ tag: m[1], attrs });
  }
  return out;
}

function starterVars(now: Date, over: Record<string, Value>): Vars {
  const vars = docVars();
  for (const [k, v] of systemVars(1080, 2400, now)) vars.set(k, v);
  vars.set('has_weather', 1);
  for (const [k, v] of Object.entries(over)) vars.set(k, v);
  const greeting = /<Var name="greeting" type="string" expression="([^"]*)"/.exec(STARTER_MANIFEST)![1];
  vars.set('greeting', evalString(greeting, vars));
  return vars;
}

const argbToCss = (v: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(v.trim());
  return m ? { fill: `#${m[2]}`, opacity: +(parseInt(m[1], 16) / 255).toFixed(3) } : { fill: v, opacity: 1 };
};

/** The starter manifest drawn as a phone screen, at `scale` of 1080 × 2400. */
function phone(x0: number, y0: number, scale: number, now: Date, over: Record<string, Value> = {}): { svg: string; boxes: Map<string, { x: number; y: number }> } {
  const vars = starterVars(now, over);
  const W = 1080 * scale;
  const H = 2400 * scale;
  const id = `p${Math.round(x0)}_${Math.round(y0)}`;
  const boxes = new Map<string, { x: number; y: number }>();
  let out = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#3a3f8f"/><stop offset="0.55" stop-color="#8c4a7d"/><stop offset="1" stop-color="#e0805a"/></linearGradient>
<clipPath id="${id}c"><rect x="${x0}" y="${y0}" width="${W}" height="${H}" rx="${36 * scale * 3}"/></clipPath></defs>
<rect x="${x0 - 6}" y="${y0 - 6}" width="${W + 12}" height="${H + 12}" rx="${36 * scale * 3 + 6}" fill="#000" stroke="#3a3f4b" stroke-width="2"/>
<g clip-path="url(#${id}c)"><rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="url(#${id})"/>`;
  for (const p of piecesOf(STARTER_MANIFEST)) {
    const a = p.attrs;
    if (a.visibility !== undefined && evalNumber(a.visibility, vars, 1) <= 0) continue;
    const n = (k: string, d = 0) => (a[k] === undefined ? d : evalNumber(a[k], vars));
    const x = x0 + n('x') * scale;
    const y = y0 + n('y') * scale;
    if (a.name) boxes.set(a.name, { x, y });
    if (p.tag === 'Rectangle') {
      const { fill, opacity } = argbToCss(a.fillColor ?? '#ffffffff');
      out += `<rect x="${x}" y="${y}" width="${n('w') * scale}" height="${n('h') * scale}" rx="${n('cornerRadius') * scale}" fill="${fill}" fill-opacity="${opacity}"/>`;
    } else {
      const text = p.tag === 'DateTime' ? formatDate(a.format ?? 'HH:mm', now) : a.textExp !== undefined ? evalString(a.textExp, vars) : a.format !== undefined ? formatWithParas(a.format, a.paras ?? null, vars) : (a.text ?? '');
      const size = n('size', 18) * scale;
      const { fill, opacity } = argbToCss(a.color ?? '#ffffffff');
      const anchor = a.align === 'center' ? 'middle' : a.align === 'right' ? 'end' : 'start';
      out += `<text x="${x}" y="${y + size * 0.82}" text-anchor="${anchor}" font-family="${SANS}" font-size="${size}" ${a.bold === 'true' ? 'font-weight="700"' : p.tag === 'DateTime' && n('size') > 150 ? 'font-weight="300"' : ''} fill="${fill}" fill-opacity="${opacity}">${esc(text)}</text>`;
    }
  }
  out += '</g>';
  return { svg: out, boxes };
}

/** The starter lock screen with each piece's key attribute pointed out. */
export function starterAnatomy(): string {
  const s = 1 / 3;
  const px = 40;
  const py = 40;
  const { svg: screen, boxes } = phone(px, py, s, DOC_NOW);
  const notes: [string, string, string][] = [
    ['clock', '<DateTime format=', '"HH:mm"'],
    ['date', '<DateTime format=', '"d/M EE"'],
    ['weather', '<Text textExp=', `"@weather_description+' '+@weather_temperature"`],
    ['hello', '<Text textExp=', '"@greeting"   (a <Var> with ifelse by hour)'],
    ['bar_fill', '<Rectangle w=', '"840*#battery_level/100"'],
    ['battery', '<Text format=', '"%d%%" paras="#battery_level"'],
  ];
  const lx = px + 1080 * s + 70;
  let body = screen;
  const ys = [130, 210, 290, 370, 640, 720];
  notes.forEach(([name, head, code], i) => {
    const b = boxes.get(name)!;
    const ty = ys[i];
    const ax = name === 'bar_fill' ? b.x + 230 : px + 1080 * s / 2 + 70;
    const ay = b.y + (name === 'bar_fill' ? 4 : name === 'clock' ? 40 : 10);
    body += `<path d="M ${ax} ${ay} C ${lx - 40} ${ay}, ${lx - 60} ${ty - 5}, ${lx - 8} ${ty - 5}" fill="none" stroke="${C.accent}" stroke-width="1.5" stroke-opacity="0.8"/>
<circle cx="${ax}" cy="${ay}" r="3.5" fill="${C.accent}"/>
<text x="${lx}" y="${ty - 14}" font-family="${SANS}" font-size="13" fill="${C.muted}">${esc(name)}</text>
<text x="${lx}" y="${ty + 4}" font-family="${MONO}" font-size="14"><tspan fill="${C.muted}">${esc(head)}</tspan><tspan fill="${C.text}">${esc(code)}</tspan></text>`;
  });
  body += `<text x="${lx}" y="${py + 20}" font-family="${SANS}" font-size="22" font-weight="700" fill="${C.text}">Starter lock screen</text>
<text x="${lx}" y="${py + 44}" font-family="${SANS}" font-size="14" fill="${C.muted}">docs/maml/examples/starter/manifest.xml · Tue 17 Mar 2026, 21:05 · battery 82%</text>`;
  return svg(lx + 520, py * 2 + 800, body, 'Starter lock screen anatomy');
}

/** The same layout in three states, to show ifelse and visibility at work. */
export function starterStates(): string {
  const s = 0.25;
  const states: { label: string; sub: string; now: Date; over: Record<string, Value> }[] = [
    { label: '08:30 · 15%', sub: 'morning, not charging', now: new Date(2026, 2, 17, 8, 30), over: { battery_level: 15, battery_state: 0 } },
    { label: '14:10 · 64% charging', sub: 'battery_state = 1', now: new Date(2026, 2, 18, 14, 10), over: { battery_level: 64, battery_state: 1 } },
    { label: '21:05 · 82%', sub: 'evening', now: DOC_NOW, over: {} },
  ];
  let body = `<text x="32" y="44" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.text}">One layout, three moments</text>
<text x="32" y="70" font-family="${SANS}" font-size="14" fill="${C.muted}">The greeting (ifelse on #hour24), the bar width (#battery_level) and the "Charging" line (visibility) follow the phone.</text>`;
  states.forEach((st, i) => {
    const x = 50 + i * 320;
    body += phone(x, 110, s, st.now, st.over).svg;
    body += `<text x="${x + 135}" y="${110 + 600 + 34}" text-anchor="middle" font-family="${SANS}" font-size="16" font-weight="600" fill="${C.text}">${esc(st.label)}</text>
<text x="${x + 135}" y="${110 + 600 + 56}" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${C.muted}">${esc(st.sub)}</text>`;
  });
  return svg(1000, 800, body, 'One layout, three moments');
}

// ---------- layout diagrams ----------

/** How align / alignV move a text around its x/y point. */
export function alignDiagram(): string {
  const W = 1000;
  let body = `<text x="32" y="44" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.text}">x / y is an anchor point</text>
<text x="32" y="70" font-family="${SANS}" font-size="14" fill="${C.muted}">align picks which side of the text sits on x; alignV picks which edge sits on y. The orange dot is (x, y).</text>`;
  const cols: [string, string][] = [
    ['left', 'start'],
    ['center', 'middle'],
    ['right', 'end'],
  ];
  cols.forEach(([align, anchor], i) => {
    const cx = 180 + i * 320;
    const cy = 170;
    body += `<rect x="${cx - 150}" y="100" width="300" height="140" rx="10" fill="${C.panel}"/>
<line x1="${cx}" y1="110" x2="${cx}" y2="230" stroke="${C.line}" stroke-dasharray="4 4"/>
<text x="${cx}" y="${cy + 12}" text-anchor="${anchor}" font-family="${SANS}" font-size="40" font-weight="600" fill="#fff">21:05</text>
<circle cx="${cx}" cy="${cy - 20}" r="5" fill="${C.accent}"/>
<text x="${cx}" y="262" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${C.text}">align="${align}"</text>`;
  });
  const rows: [string, number][] = [
    ['top', 0],
    ['center', -0.5],
    ['bottom', -1],
  ];
  rows.forEach(([alignV, shift], i) => {
    const cx = 180 + i * 320;
    const cy = 360;
    const size = 40;
    const boxTop = cy + shift * size * 1.2;
    body += `<rect x="${cx - 150}" y="300" width="300" height="130" rx="10" fill="${C.panel}"/>
<line x1="${cx - 140}" y1="${cy}" x2="${cx + 140}" y2="${cy}" stroke="${C.line}" stroke-dasharray="4 4"/>
<rect x="${cx - 60}" y="${boxTop}" width="120" height="${size * 1.2}" fill="none" stroke="#4c5670"/>
<text x="${cx}" y="${boxTop + size * 0.95}" text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="600" fill="#fff">Tue</text>
<circle cx="${cx}" cy="${cy}" r="5" fill="${C.accent}"/>
<text x="${cx}" y="452" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${C.text}">alignV="${alignV}"</text>`;
  });
  return svg(W, 480, body, 'align and alignV');
}

/** #AARRGGBB colours: the first pair is opacity. */
export function colorDiagram(): string {
  const swatches: [string, string][] = [
    ['#ffffffff', 'solid white'],
    ['#ccffffff', '80% white'],
    ['#80ffffff', '50% white'],
    ['#40ffffff', '25% white'],
    ['#00ffffff', 'invisible'],
    ['#ffff6a1a', 'solid orange'],
    ['#80000000', '50% black'],
  ];
  let body = `<text x="32" y="44" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.text}">Colours are #AARRGGBB</text>
<text x="32" y="70" font-family="${SANS}" font-size="14" fill="${C.muted}">AA = opacity (ff solid … 00 invisible), then red, green, blue. #RRGGBB alone means solid.</text>
<defs><linearGradient id="cg" x1="0" x2="1"><stop offset="0" stop-color="#3a3f8f"/><stop offset="0.5" stop-color="#8c4a7d"/><stop offset="1" stop-color="#e0805a"/></linearGradient></defs>
<rect x="24" y="96" width="952" height="150" rx="10" fill="url(#cg)"/>`;
  swatches.forEach(([c, label], i) => {
    const x = 44 + i * 134;
    const { fill, opacity } = argbToCss(c);
    body += `<rect x="${x}" y="114" width="110" height="80" rx="10" fill="${fill}" fill-opacity="${opacity}" stroke="#ffffff" stroke-opacity="0.35" stroke-dasharray="${c.startsWith('#00') ? '4 4' : '0'}"/>
<text x="${x + 55}" y="216" text-anchor="middle" font-family="${MONO}" font-size="13" fill="#fff">${c}</text>
<text x="${x + 55}" y="234" text-anchor="middle" font-family="${SANS}" font-size="12" fill="#ffffff" fill-opacity="0.8">${label}</text>`;
  });
  const opac: [string, number][] = [
    ['ff', 100],
    ['e6', 90],
    ['cc', 80],
    ['b3', 70],
    ['99', 60],
    ['80', 50],
    ['66', 40],
    ['4d', 30],
    ['33', 20],
    ['1a', 10],
    ['00', 0],
  ];
  body += `<text x="32" y="284" font-family="${SANS}" font-size="15" font-weight="600" fill="${C.text}">Opacity pairs</text>`;
  opac.forEach(([hex, pct], i) => {
    const x = 32 + i * 86;
    body += `<rect x="${x}" y="298" width="76" height="46" rx="8" fill="${C.panel}"/>
<text x="${x + 38}" y="318" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${C.num}">${hex}</text>
<text x="${x + 38}" y="336" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${C.muted}">${pct}%</text>`;
  });
  return svg(1000, 368, body, 'ARGB colours');
}

/** Arc angles: 0° is 3 o'clock, angles grow clockwise. */
export function arcDiagram(): string {
  const vars = docVars();
  const arcs: { start: string; sweep: string; label: string }[] = [
    { start: '0', sweep: '90', label: 'startAngle="0" sweep="90"' },
    { start: '-90', sweep: '180', label: 'startAngle="-90" sweep="180"' },
    { start: '-90', sweep: '360*#battery_level/100', label: 'sweep="360*#battery_level/100"' },
    { start: '135', sweep: '270', label: 'startAngle="135" sweep="270"' },
  ];
  let body = `<text x="32" y="44" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.text}">Arc: startAngle and sweep</text>
<text x="32" y="70" font-family="${SANS}" font-size="14" fill="${C.muted}">0° points right (3 o'clock) and angles grow clockwise, so -90 starts at the top. Battery is 82% here.</text>`;
  arcs.forEach((a, i) => {
    const cx = 130 + i * 245;
    const cy = 200;
    const r = 80;
    const st = evalNumber(a.start, vars);
    const sw = Math.min(359.99, evalNumber(a.sweep, vars));
    const pt = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)].map((v) => +v.toFixed(2));
    const [x1, y1] = pt(st);
    const [x2, y2] = pt(st + sw);
    body += `<rect x="${cx - 112}" y="96" width="224" height="250" rx="10" fill="${C.panel}"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="16"/>
<path d="M ${x1} ${y1} A ${r} ${r} 0 ${sw > 180 ? 1 : 0} 1 ${x2} ${y2}" fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>
<circle cx="${x1}" cy="${y1}" r="6" fill="${C.accent}"/>
<text x="${cx}" y="${cy + 7}" text-anchor="middle" font-family="${SANS}" font-size="20" font-weight="600" fill="#fff">${+sw.toFixed(1)}°</text>
<text x="${cx}" y="316" text-anchor="middle" font-family="${MONO}" font-size="11.5" fill="${C.text}">${esc(a.label)}</text>
<text x="${cx}" y="334" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${C.muted}">orange dot = start</text>`;
  });
  return svg(1000, 370, body, 'Arc angles');
}

// ---------- the editor itself ----------

/** A sketch of the side panel for a Date / time piece and a Text piece, labelled as in the app. */
export function inspectorSketch(): string {
  const field = (x: number, y: number, w: number, label: string, value: string, hot = false) => `
<text x="${x}" y="${y}" font-family="${SANS}" font-size="12" fill="${C.muted}">${esc(label)}</text>
<rect x="${x}" y="${y + 6}" width="${w}" height="30" rx="6" fill="#0f1218" stroke="${hot ? C.accent : C.line}" stroke-width="${hot ? 2 : 1}"/>
<text x="${x + 10}" y="${y + 26}" font-family="${MONO}" font-size="13">${codeSpans(value)}</text>`;
  const chip = (x: number, y: number, label: string, on = false) => {
    const w = sansW(label, 12) + 20;
    return {
      w,
      svg: `<rect x="${x}" y="${y}" width="${w}" height="24" rx="12" fill="${on ? '#3a2416' : '#1f2430'}" stroke="${on ? C.accent : C.line}"/><text x="${x + w / 2}" y="${y + 16}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${on ? '#ffd2b8' : C.text}">${esc(label)}</text>`,
    };
  };
  const panel = (x: number, title: string, name: string, inner: string, foot: string) => `
<rect x="${x}" y="96" width="440" height="420" rx="12" fill="${C.panel}" stroke="${C.line}"/>
<text x="${x + 20}" y="128" font-family="${SANS}" font-size="15" fill="${C.muted}">←</text>
<text x="${x + 44}" y="128" font-family="${SANS}" font-size="15" font-weight="700" fill="${C.text}">${esc(title)}</text>
<text x="${x + 44 + sansW(title, 15) + 12}" y="128" font-family="${SANS}" font-size="13" fill="${C.muted}">${esc(name)}</text>
<line x1="${x}" y1="146" x2="${x + 440}" y2="146" stroke="${C.line}"/>
<text x="${x + 20}" y="172" font-family="${SANS}" font-size="11" font-weight="700" letter-spacing="1" fill="${C.muted}">TEXT</text>
${inner}
<line x1="${x}" y1="470" x2="${x + 440}" y2="470" stroke="${C.line}"/>
<text x="${x + 20}" y="498" font-family="${SANS}" font-size="13" fill="${C.muted}">${esc(foot)}</text>`;
  let chips = '';
  let cx = 40;
  let cy = 236;
  for (const [label, on] of [
    ['24h time', false],
    ['12h time', false],
    ['Hour', false],
    ['Minutes', false],
    ['Weekday', false],
    ['Short date', false],
    ['Long date', false],
    ['Numeric date', false],
  ] as [string, boolean][]) {
    const c = chip(cx, cy, label, on);
    if (cx + c.w > 460) {
      cx = 40;
      cy += 32;
    }
    chips += chip(cx, cy, label, on).svg;
    cx += c.w + 8;
  }
  const dt =
    field(40, 186, 400, 'Format', 'd/M EE', true) +
    chips +
    field(40, 320, 120, 'Size', '54') +
    `<text x="180" y="320" font-family="${SANS}" font-size="12" fill="${C.muted}">Style</text>${chip(180, 330, 'B  Bold').svg}` +
    field(40, 380, 400, 'Colour', '#ccffffff');
  const tx = field(500, 186, 400, 'Text formula', "@weather_description+' '+@weather_temperature", true) + field(500, 250, 120, 'Size', '46') + `<text x="640" y="250" font-family="${SANS}" font-size="12" fill="${C.muted}">Style</text>${chip(640, 260, 'B  Bold').svg}` + field(500, 310, 400, 'Colour', '#ccffffff') + `<text x="500" y="384" font-family="${SANS}" font-size="11" font-weight="700" letter-spacing="1" fill="${C.muted}">VISIBILITY</text>` + field(500, 400, 400, 'Shown when', '#has_weather');
  const body = `<text x="32" y="44" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.text}">Where formulas go in the side panel</text>
<text x="32" y="70" font-family="${SANS}" font-size="14" fill="${C.muted}">Click a piece on the lock screen preview. Fields outlined in orange take the code shown in this guide; press Enter or click away to write it.</text>
${panel(20, 'Date / time', 'date', dt, 'Show in code · Save to inventory')}
${panel(480, 'Text', 'weather', tx, 'Show in code · Save to inventory')}`;
  return svg(940, 540, body, 'Inspector fields');
}

/** Every picture, by file name. */
export function allDocImages(sheets: { file: string; title: string; subtitle: string; examples: DocExample[] }[]): Record<string, string> {
  const out: Record<string, string> = {
    'starter-anatomy.svg': starterAnatomy(),
    'starter-states.svg': starterStates(),
    'align.svg': alignDiagram(),
    'colors.svg': colorDiagram(),
    'arc.svg': arcDiagram(),
    'inspector.svg': inspectorSketch(),
  };
  for (const s of sheets) out[s.file] = exampleSheet(s.title, s.subtitle, s.examples);
  return out;
}
