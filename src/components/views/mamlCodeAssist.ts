// What the code editor knows about MAML (lock screen manifest.xml): the
// elements and their attributes for autocomplete, the phone's variables and
// functions inside formulas, hover help, colour swatches you can click to
// change, and problems underlined where they are.

import { xml, xmlLanguage, type ElementSpec } from '@codemirror/lang-xml';
import { syntaxTree } from '@codemirror/language';
import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import { Decoration, EditorView, hoverTooltip, MatchDecorator, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { FUNC_INFO, VAR_INFO, formulaProblems, tokenAt } from '../../lib/mamlHelp';
import type { Value } from '../../lib/maml';

// ---------------------------------------------------------------- schema

const ALIGN = { name: 'align', values: ['left', 'center', 'right'] };
const ALIGN_V = { name: 'alignV', values: ['top', 'center', 'bottom'] };
const BOOL = (name: string) => ({ name, values: ['true', 'false'] });
const PLACE = ['name', 'x', 'y', 'w', 'h', ALIGN, ALIGN_V, 'alpha', 'visibility', 'rotation', 'pivotX', 'pivotY', 'scale', 'scaleX', 'scaleY'];
const SHAPE = [...PLACE, 'fillColor', 'strokeColor', 'weight', { name: 'strokeAlign', values: ['inner', 'center', 'outer'] }, { name: 'cap', values: ['butt', 'round', 'square'] }, 'fillShaders', 'strokeShaders'];
const TEXT = [...PLACE, 'size', 'color', BOOL('bold'), 'fontFamily', 'fontScale', BOOL('multiLine'), 'spacing', 'shadowColor', 'shadowDx', 'shadowDy', 'shadowRadius', BOOL('marqueeSpeed'), 'width'];
const ANIM = ['repeat', 'delay', 'initPause', 'loop', 'tag'];

/** Each element: what it is (for hover and the completion list) and its attributes. */
const TAGS: { name: string; info: string; attrs?: (string | { name: string; values?: string[] })[] }[] = [
  { name: 'Lockscreen', info: 'The root of a lock screen layout.', attrs: ['version', 'frameRate', 'screenWidth', 'displayDesktop', 'useVariableUpdater', BOOL('vibrate'), 'compatibleVersion'] },
  { name: 'Var', info: 'A named value (a formula) other pieces read as #name or @name.', attrs: ['name', 'expression', { name: 'type', values: ['number', 'string', 'number[]', 'string[]'] }, BOOL('const'), 'threshold', 'values'] },
  { name: 'VariableBinders', info: 'Holds the data sources (weather, steps…).' },
  { name: 'ContentProviderBinder', info: 'Reads rows from an app’s data (weather, health…) into variables.', attrs: ['name', 'uri', 'columns', 'where', 'order', 'countName', 'dependency'] },
  { name: 'Variable', info: 'One column of a data source as a variable.', attrs: ['name', { name: 'type', values: ['int', 'long', 'float', 'double', 'string'] }, 'column', 'row'] },
  { name: 'Group', info: 'A box of pieces that move, fade and hide together. x / y of children are relative to it.', attrs: [...PLACE, BOOL('clip'), 'layered'] },
  { name: 'Image', info: 'A picture from the theme’s files.', attrs: [...PLACE, 'src', 'srcExp', 'srcid', BOOL('antiAlias'), 'tint', 'blur'] },
  { name: 'Text', info: 'Words. Fixed (text), a formula (textExp) or a format with values (format + paras).', attrs: [...TEXT, 'text', 'textExp', 'format', 'formatExp', 'paras'] },
  { name: 'DateTime', info: 'The date / time as text, from a pattern like HH:mm or EEEE, d MMM.', attrs: [...TEXT, 'format', 'formatExp', 'value'] },
  { name: 'Time', info: 'The time drawn with digit pictures (time_0.png … time_9.png, time_dot.png).', attrs: [...PLACE, 'src', 'format', 'formatExp', 'space'] },
  { name: 'ImageNumber', info: 'A number drawn with digit pictures (number_0.png …).', attrs: [...PLACE, 'src', 'number', 'numberExp', 'space'] },
  { name: 'Rectangle', info: 'A box. cornerRadius rounds it.', attrs: [...SHAPE, 'cornerRadius'] },
  { name: 'Circle', info: 'A circle. x / y is its centre, r its radius.', attrs: [...SHAPE, 'r'] },
  { name: 'Ellipse', info: 'An oval filling x / y / w / h.', attrs: SHAPE },
  { name: 'Arc', info: 'Part of an oval: from startAngle (0 = 3 o’clock) through sweep degrees.', attrs: [...SHAPE, 'startAngle', 'sweep', BOOL('close')] },
  { name: 'Line', info: 'A straight line from x,y to x1,y1.', attrs: [...SHAPE, 'x1', 'y1', 'color'] },
  { name: 'Wallpaper', info: 'The lock screen wallpaper.', attrs: PLACE },
  { name: 'Video', info: 'A video from the theme’s files.', attrs: [...PLACE, 'src', BOOL('loop'), BOOL('autoPlay')] },
  { name: 'Button', info: 'A tap area that runs commands (in Triggers).', attrs: [...PLACE, 'listener'] },
  { name: 'Unlocker', info: 'The slide-to-unlock control.', attrs: [...PLACE, 'bounceInitSpeed', 'bounceAcceleration', BOOL('alwaysShow')] },
  { name: 'Slider', info: 'A draggable control with start / end points.', attrs: [...PLACE, 'bounceInitSpeed', 'bounceAcceleration'] },
  { name: 'StartPoint', info: 'Where a slider starts.', attrs: ['x', 'y', 'w', 'h'] },
  { name: 'EndPoint', info: 'Where a slider ends (and what happens there).', attrs: ['x', 'y', 'w', 'h'] },
  { name: 'NormalState', info: 'What shows while nothing is touched.' },
  { name: 'PressedState', info: 'What shows while it is pressed.' },
  { name: 'ReachedState', info: 'What shows when the end is reached.' },
  { name: 'Triggers', info: 'Commands run when something happens.' },
  { name: 'Trigger', info: 'Commands for one event (down, up, double, …).', attrs: [{ name: 'action', values: ['down', 'up', 'double', 'long', 'cancel', 'reached', 'unreached', 'move'] }, 'condition'] },
  { name: 'ExternalCommands', info: 'Commands run on lock screen events (resume, pause…).' },
  { name: 'VariableCommand', info: 'Sets a Var to a new value.', attrs: ['name', 'expression', { name: 'type', values: ['number', 'string'] }, 'condition', 'delay'] },
  { name: 'Command', info: 'Changes a property of a piece (e.g. target="clock.visibility").', attrs: ['target', 'value', 'condition', 'delay'] },
  { name: 'IntentCommand', info: 'Opens an app or screen.', attrs: ['action', 'package', 'class', 'uri', { name: 'type', values: ['activity', 'broadcast', 'service'] }, 'condition'] },
  { name: 'SoundCommand', info: 'Plays a sound from the theme.', attrs: ['sound', 'volume', BOOL('loop'), BOOL('keepCur'), 'condition'] },
  { name: 'AnimationCommand', info: 'Starts / stops a piece’s animations.', attrs: ['target', { name: 'command', values: ['play', 'pause', 'resume', 'stop'] }, 'condition'] },
  { name: 'PositionAnimation', info: 'Moves a piece between Position frames.', attrs: ANIM },
  { name: 'AlphaAnimation', info: 'Fades a piece between Alpha frames.', attrs: ANIM },
  { name: 'RotationAnimation', info: 'Turns a piece between Rotation frames.', attrs: ANIM },
  { name: 'SizeAnimation', info: 'Resizes a piece between Size frames.', attrs: ANIM },
  { name: 'SourcesAnimation', info: 'Swaps pictures over time.', attrs: ANIM },
  { name: 'Position', info: 'A frame: where, at time (ms).', attrs: ['x', 'y', 'time'] },
  { name: 'Alpha', info: 'A frame: how visible (0–255), at time (ms).', attrs: ['a', 'time'] },
  { name: 'Rotation', info: 'A frame: angle, at time (ms).', attrs: ['angle', 'time'] },
  { name: 'Size', info: 'A frame: w / h, at time (ms).', attrs: ['w', 'h', 'time'] },
  { name: 'Source', info: 'A frame: picture, at time (ms).', attrs: ['src', 'time', 'x', 'y'] },
  { name: 'Mask', info: 'Shows the piece only where this picture is opaque.', attrs: ['src', 'x', 'y', 'w', 'h', ALIGN] },
  { name: 'MusicControl', info: 'The music player controls.', attrs: [...PLACE, BOOL('autoShow')] },
  { name: 'FramerateController', info: 'Changes the drawing rate over time.', attrs: ['name', BOOL('loop')] },
];
const TAG_INFO = new Map(TAGS.map((t) => [t.name, t.info]));

const ATTR_INFO: Record<string, string> = {
  name: 'The piece’s name. Formulas read its properties as #name.visibility, #name.actual_x …',
  x: 'Left edge (or the point align / alignV refer to). A formula.',
  y: 'Top edge (or the point alignV refers to). A formula.',
  w: 'Width. A formula.',
  h: 'Height. A formula.',
  align: 'Which side of the piece x refers to.',
  alignV: 'Which side of the piece y refers to.',
  alpha: 'How visible: 0 hidden … 255 solid. A formula.',
  visibility: 'Shown while this formula is not 0.',
  rotation: 'Turn in degrees around pivotX / pivotY.',
  color: 'Colour as #AARRGGBB (alpha first) or #RRGGBB.',
  fillColor: 'Fill colour as #AARRGGBB (alpha first) or #RRGGBB.',
  strokeColor: 'Outline colour as #AARRGGBB (alpha first) or #RRGGBB.',
  weight: 'Outline thickness.',
  size: 'Text size in pixels.',
  text: 'Fixed words.',
  textExp: 'Words from a formula: quote words in single quotes, join with +.',
  format: 'For Text: a pattern like %d or %s filled from paras. For DateTime / Time: a date pattern like HH:mm.',
  formatExp: 'A formula that gives the format.',
  paras: 'The values for %d / %s in format, separated by commas.',
  expression: 'The formula this value is worked out from.',
  src: 'A picture in the theme, relative to this manifest.',
  srcExp: 'A formula giving the picture’s name.',
  cornerRadius: 'Corner rounding.',
  r: 'Radius.',
  startAngle: 'Where the arc starts: 0 = 3 o’clock, -90 = 12 o’clock.',
  sweep: 'How far the arc goes, in degrees (360 = full ring).',
  condition: 'Runs only while this formula is not 0.',
  target: 'What to change, e.g. clock.visibility or myvar.',
  countName: 'A variable set to the number of rows found (0 = no data yet).',
};

const SCHEMA: ElementSpec[] = TAGS.map((t) => ({
  name: t.name,
  top: t.name === 'Lockscreen',
  attributes: t.attrs,
  completion: { info: t.info, type: 'type' },
}));

/** XML with MAML-aware tag / attribute completion and auto-closing tags. */
export const mamlXml = () => xml({ elements: SCHEMA, autoCloseTags: true });

// ---------------------------------------------------------------- formulas inside attributes

/** Attributes whose value is a formula (others are plain text, names, colours or paths). */
const FORMULA_ATTRS = new Set([
  'x', 'y', 'w', 'h', 'x1', 'y1', 'alpha', 'visibility', 'rotation', 'pivotX', 'pivotY', 'scale', 'scaleX', 'scaleY', 'size', 'r', 'cornerRadius', 'weight',
  'textExp', 'formatExp', 'paras', 'expression', 'condition', 'startAngle', 'sweep', 'number', 'numberExp', 'srcExp', 'value', 'angle', 'a', 'spacing',
]);

/** The attribute value the position is in: its attribute name and where the value text starts / ends. */
function attributeAt(state: EditorView['state'], pos: number): { attr: string; tag: string | null; from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(pos, -1);
  if (node.name !== 'AttributeValue') node = syntaxTree(state).resolveInner(pos, 1);
  if (node.name !== 'AttributeValue') return null;
  const nameNode = node.prevSibling?.prevSibling ?? node.parent?.getChild('AttributeName');
  const attr = nameNode && nameNode.name === 'AttributeName' ? state.sliceDoc(nameNode.from, nameNode.to) : '';
  const tagNode = node.parent?.parent?.getChild('TagName') ?? node.parent?.getChild('TagName');
  const tag = tagNode ? state.sliceDoc(tagNode.from, tagNode.to) : null;
  const quoted = /^["']/.test(state.sliceDoc(node.from, node.from + 1));
  const closed = node.to - node.from > 1 && /["']$/.test(state.sliceDoc(node.to - 1, node.to));
  return { attr, tag, from: node.from + (quoted ? 1 : 0), to: node.to - (closed ? 1 : 0) };
}

/** Names this file defines: Var / Variable names and element names. */
function namesIn(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of doc.matchAll(/<(Var|Variable|ContentProviderBinder)\b[^>]*?\bname\s*=\s*"([^"]+)"/g)) out.set(m[2], m[1] === 'ContentProviderBinder' ? 'Data source' : m[1] === 'Variable' ? 'From a data source' : 'Var in this file');
  for (const m of doc.matchAll(/<([A-Z][\w]*)\b[^>]*?\bname\s*=\s*"([A-Za-z_][\w]*)"/g)) if (!out.has(m[2])) out.set(m[2], `${m[1]} in this file`);
  return out;
}

let namesCache: { doc: string; names: Map<string, string> } | null = null;
function cachedNames(state: EditorView['state']) {
  const doc = state.doc.toString();
  if (namesCache?.doc !== doc) namesCache = { doc, names: namesIn(doc) };
  return namesCache.names;
}

const PROPS = ['visibility', 'actual_x', 'actual_y', 'actual_w', 'actual_h', 'alpha', 'bmp_width', 'bmp_height', 'text_width'];

function formulaCompletion(ctx: CompletionContext): CompletionResult | null {
  const at = attributeAt(ctx.state, ctx.pos);
  if (!at || ctx.pos < at.from) return null;
  const isFormula = FORMULA_ATTRS.has(at.attr) || (at.attr === 'value' && at.tag === 'Command');
  const before = ctx.state.sliceDoc(at.from, ctx.pos);
  const tok = tokenAt(before, before.length);
  if (!tok) return null;
  // #… in a colour attribute is a colour, not a variable.
  if (/color$|^tint$/i.test(at.attr) || (!isFormula && tok.kind === 'fn')) return null;
  const from = at.from + tok.start + tok.sigil.length;
  if (tok.kind === 'var') {
    // #piece.prop
    const dot = tok.prefix.lastIndexOf('.');
    if (dot > 0) {
      return { from: from + dot + 1, options: PROPS.map((p) => ({ label: p, type: 'property' })), validFor: /^\w*$/ };
    }
    const options: Completion[] = [];
    for (const [name, desc] of Object.entries(VAR_INFO)) options.push({ label: name, detail: desc, type: 'variable', boost: 1 });
    for (const [name, desc] of cachedNames(ctx.state)) if (!(name in VAR_INFO)) options.push({ label: name, detail: desc, type: 'variable', boost: 2 });
    return { from, options, validFor: /^[\w.]*$/ };
  }
  if (!ctx.explicit && tok.prefix.length < 2) return null;
  return {
    from,
    options: FUNC_INFO.map((f) => ({ label: f.name, detail: f.sig, info: f.desc, type: 'function', apply: f.insert })),
    validFor: /^\w*$/,
  };
}

/** Variable / function completion inside formula attributes, next to the XML schema completion. */
const formulaCompletions = xmlLanguage.data.of({ autocomplete: formulaCompletion });

// ---------------------------------------------------------------- hover help

function wordAround(text: string, i: number) {
  let s = i;
  let e = i;
  while (s > 0 && /[\w.]/.test(text[s - 1])) s--;
  while (e < text.length && /[\w]/.test(text[e])) e++;
  return { s, e, word: text.slice(s, e) };
}

const hoverHelp = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const { s, e, word } = wordAround(line.text, pos - line.from);
  if (!word) return null;
  const sigil = line.text[s - 1];
  const node = syntaxTree(view.state).resolveInner(pos, 1);
  let title = '';
  let body = '';
  if ((sigil === '#' || sigil === '@') && node.name === 'AttributeValue') {
    const [head, prop] = word.split('.');
    const at = attributeAt(view.state, pos);
    if (at && /color$/i.test(at.attr)) return null;
    title = `${sigil}${word}`;
    body = VAR_INFO[head] ?? cachedNames(view.state).get(head) ?? 'Not defined in this file or by the phone, so it reads as ' + (sigil === '#' ? '0.' : 'empty text.');
    if (prop) body += ` · .${prop} of it`;
    if (sigil === '@') body += ' (read as text)';
  } else if (node.name === 'TagName' && TAG_INFO.has(word)) {
    title = `<${word}>`;
    body = TAG_INFO.get(word)!;
  } else if (node.name === 'AttributeName' && ATTR_INFO[word]) {
    title = word;
    body = ATTR_INFO[word];
  } else if (node.name === 'AttributeValue' && line.text[e] === '(') {
    const f = FUNC_INFO.find((x) => x.name === word);
    if (!f) return null;
    title = f.sig;
    body = f.desc;
  } else return null;
  return {
    pos: line.from + s - (sigil === '#' || sigil === '@' ? 1 : 0),
    end: line.from + e,
    above: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-maml-hover';
      const t = document.createElement('strong');
      t.textContent = title;
      const b = document.createElement('div');
      b.textContent = body;
      dom.append(t, b);
      return { dom };
    },
  };
});

// ---------------------------------------------------------------- colour swatches

/** #AARRGGBB / #RRGGBB → CSS colour. */
export function argbCss(hex: string): string | null {
  const h = hex.replace('#', '');
  if (h.length === 6) return `#${h}`;
  if (h.length !== 8) return null;
  const a = parseInt(h.slice(0, 2), 16) / 255;
  return `rgba(${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${parseInt(h.slice(6, 8), 16)},${a.toFixed(3)})`;
}

class SwatchWidget extends WidgetType {
  constructor(
    readonly hex: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: SwatchWidget) {
    return other.hex === this.hex && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = 'cm-maml-swatch';
    el.title = 'Click to pick a colour (alpha is kept)';
    const inner = document.createElement('span');
    inner.style.background = argbCss(this.hex) ?? 'transparent';
    el.appendChild(inner);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      const h = this.hex.slice(1);
      const alpha = h.length === 8 ? h.slice(0, 2) : '';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = `#${h.slice(-6)}`.toLowerCase();
      input.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0';
      document.body.appendChild(input);
      const at = this.from;
      let len = this.hex.length;
      input.addEventListener('input', () => {
        const next = `#${alpha}${input.value.slice(1)}`;
        view.dispatch({ changes: { from: at, to: at + len, insert: next } });
        len = next.length;
      });
      input.addEventListener('change', () => input.remove());
      input.addEventListener('blur', () => input.remove());
      input.click();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const swatchMatcher = new MatchDecorator({
  regexp: /(?<=(?:[Cc]olor|tint)\s*=\s*["'])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/g,
  decoration: (m, _view, pos) => Decoration.widget({ widget: new SwatchWidget(m[0], pos), side: -1 }),
});

const swatches = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = swatchMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = swatchMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------- problems

/** Treats names this file defines (and piece.prop) as known. */
class KnownNames extends Map<string, Value> {
  constructor(private names: Map<string, string>) {
    super();
  }
  has(name: string) {
    const head = name.split('.')[0].replace(/\[.*$/, '');
    return this.names.has(head) || head in VAR_INFO || /^(screen_|time|hour|minute|second|year|month|date|day_|battery|ampm|touch_|frame_|music|sms_|call_|notification|wifi|bluetooth|data_|volume|ring|unlocker|intercept|__|sys|next_alarm|weather|step|raw_|actual_|is_|has_)/.test(head);
  }
  get(_name: string): Value | undefined {
    return undefined;
  }
}

function xmlDiagnostics(view: EditorView, maml: boolean): Diagnostic[] {
  const text = view.state.doc.toString();
  const out: Diagnostic[] = [];
  const parsed = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  const err = parsed.querySelector('parsererror');
  if (err) {
    const msg = (err.textContent ?? 'XML syntax error').replace(/\s+/g, ' ');
    const m = /line (\d+) at column (\d+)/.exec(msg);
    const lineNo = m ? Math.min(Number(m[1]), view.state.doc.lines) : 1;
    const line = view.state.doc.line(lineNo);
    const col = m ? Math.min(Number(m[2]) - 1, line.length) : 0;
    const detail = /column \d+:\s*(.*?)(?:Below is a rendering.*)?$/.exec(msg)?.[1] ?? msg;
    out.push({ from: Math.max(line.from, line.from + col - 1), to: Math.min(line.to, line.from + col + 1) || line.to, severity: 'error', message: detail.trim() || 'XML syntax error', source: 'XML' });
    return out; // the tree below is unreliable until the XML is fixed
  }
  if (!maml || text.length > 600_000) return out;
  const names = new KnownNames(namesIn(text));
  const attrRe = /\b([A-Za-z][\w]*)\s*=\s*"([^"]*)"/g;
  for (let m = attrRe.exec(text); m; m = attrRe.exec(text)) {
    if (!FORMULA_ATTRS.has(m[1]) || !m[2].trim()) continue;
    const problems = formulaProblems(m[2].replace(/&amp;/g, '&'), names).filter((p) => !p.includes('single quotes'));
    if (!problems.length) continue;
    const from = m.index + m[0].indexOf('"') + 1;
    out.push({ from, to: from + m[2].length, severity: /not closed|extra closing|break the XML/.test(problems[0]) ? 'error' : 'warning', message: problems.join('\n'), source: m[1] });
  }
  return out;
}

const assistTheme = EditorView.baseTheme({
  '.cm-maml-swatch': { display: 'inline-block', width: '11px', height: '11px', margin: '0 4px 0 1px', verticalAlign: '-1px', borderRadius: '3px', cursor: 'pointer', backgroundImage: 'conic-gradient(#888 25%, #ccc 0 50%, #888 0 75%, #ccc 0)', backgroundSize: '6px 6px', boxShadow: '0 0 0 1px rgba(255,255,255,0.25)', overflow: 'hidden' },
  '.cm-maml-swatch > span': { display: 'block', width: '100%', height: '100%' },
  '.cm-maml-hover': { padding: '6px 9px', maxWidth: '340px', fontSize: '12px', lineHeight: '1.45' },
  '.cm-maml-hover strong': { display: 'block', fontFamily: 'var(--mono)', marginBottom: '2px' },
  '.cm-diagnostic': { fontFamily: 'var(--font)', fontSize: '12px', whiteSpace: 'pre-wrap' },
});

/**
 * Everything above, for an XML file. A lock screen layout (`maml`) gets the
 * element schema, formula completion and formula checks; any XML gets colour
 * swatches and the well-formedness check. `lint` is off for read-only references.
 */
export function xmlAssist(maml: boolean, lint: boolean): Extension[] {
  return [
    maml ? [mamlXml(), formulaCompletions, hoverHelp] : xml(),
    swatches,
    assistTheme,
    lint ? linter((v) => xmlDiagnostics(v, maml), { delay: 500 }) : [],
  ];
}
