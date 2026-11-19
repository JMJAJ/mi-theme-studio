// Try it: a code editor on the left where every line is worked out on its own
// (formulas, date patterns, formats, conditions, names, pasted MAML elements),
// and the output on the right, each result level with its line, or the whole
// script drawn as a lock screen by the editor's own preview.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorView, keymap } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { AlertTriangle, Check, Copy, Eye, EyeOff, ListTree, Loader2, MapPin, RefreshCw, RotateCcw, Search, Smartphone } from 'lucide-react';
import type { FileInfo } from '../../lib/types';
import { sampleVars } from '../../lib/mamlDocExamples';
import { FUNC_INFO, VAR_INFO } from '../../lib/mamlHelp';
import { cachedLiveData, fetchLiveData, liveColumns, liveVars, type LiveData } from '../../lib/liveData';
import { countElements, moveInScript, runScript, scriptLayout, type LineResult, type Unit } from '../../lib/playground';
import { SAMPLE_COLUMNS } from '../../lib/sampleData';
import { useGuide } from '../../state/guide';
import { findExtension, showReplace } from './findPanel';
import { overlayLockscreen } from '../../lib/mamlBlocks';
import { AlignToggle, buildScene, MamlCanvas, ThemePhone, useHasLockLayout } from './MamlPreview';
import { PhoneSwitch, usePhoneMode } from './PhoneSwitch';
import { applyMoves, usePhoneMoves } from './PhoneMoves';

const SCRIPT_KEY = 'mts.try.script.v1';
const LIVE_KEY = 'mts.try.live.on.v1';

const EXAMPLES: Record<string, string> = {
  'Mixed basics': `// Every line is worked out on its own. Results appear on the right.
// Move the sliders above, or set phone values here (try: battery_level = 15).
@weather_description+' '+@weather_temperature
date: d/M EE
date: h:mm a
#battery_level+'%'
ifelse(#hour24{12,'Good morning',#hour24{18,'Good afternoon','Good evening')
fmt: %02d:%02d | #hour24,#minute
visible: eq(#battery_state,1)

// Names: set once, use in the lines below
greeting = 'Hi, '+@name
@greeting+'!'

// Numbers for positions, sizes and rings
360*#battery_level/100
#screen_width/2

// Paste lines from a manifest
<Text textExp="strToUpperCase(@weather_city)" size="60"/>`,
  'Dates and times': `// date: works like <DateTime format="…"/>
date: HH:mm
date: h:mm a
date: HH:mm:ss
date: d/M EE
date: EEE, d MMM
date: EEEE
date: d MMMM yyyy
date: yyyy-MM-dd
date: 'Today is' EEEE
// Inside a formula
formatDate('d/M EE',#time)+'  '+@weather_temperature
// The parts as numbers
#hour24
#minute
#day_of_week
#month+1`,
  Battery: `// Change the battery slider, or uncomment the next line
// battery_level = 15
#battery_level+'%'
fmt: %d%% | #battery_level
ifelse(eq(#battery_state,1),'Charging',#battery_level+'%')
ifelse(#battery_level{20,'Charge soon','OK')
visible: eq(#battery_state,1)
visible: #battery_level{20
840*#battery_level/100
360*#battery_level/100`,
  'Steps widget (several lines)': `<!-- A data source and a widget, as the Widgets gallery writes them -->
<ContentProviderBinder name="mts_steps" uri="content://com.mi.health.provider.main/activity/steps/brief" columns="steps,goal" countName="mts_has_steps">
    <Variable name="mts_steps" type="int" column="steps"/>
    <Variable name="mts_steps_goal" type="int" column="goal"/>
</ContentProviderBinder>

<Group name="steps_1" x="320" y="900" w="440" h="300">
    <Rectangle name="steps_1_bg" x="0" y="0" w="440" h="300" cornerRadius="36" fillColor="#33ffffff"/>
    <Text name="steps_1_label" x="36" y="36" size="34" color="#ccffffff" text="Steps"/>
    <Text name="steps_1_count" x="36" y="96" size="96" bold="true" color="#ffffffff" format="%d" paras="#mts_steps"/>
    <Rectangle name="steps_1_track" x="36" y="240" w="368" h="20" cornerRadius="10" fillColor="#40ffffff"/>
    <Rectangle name="steps_1_fill" x="36" y="240" w="368*min(#mts_steps/max(#mts_steps_goal,1),1)" h="20" cornerRadius="10" fillColor="#ffa8f0c0"/>
</Group>

// Plain lines can follow and use what the block set
int(#mts_steps*100/#mts_steps_goal)+'% of the goal'`,
  'Weather data source': `<!-- Turn Live on (top bar) to fill these with your city's real weather -->
<ContentProviderBinder name="wx" uri="content://weather/actualWeatherData/1" columns="city_name,description,temperature,temperature_range" countName="has_wx">
    <Variable name="wx_city" type="string" column="city_name"/>
    <Variable name="wx_desc" type="string" column="description"/>
    <Variable name="wx_temp" type="int" column="temperature"/>
    <Variable name="wx_range" type="string" column="temperature_range"/>
</ContentProviderBinder>
@wx_city
@wx_desc+' '+#wx_temp+'°'
'Today '+@wx_range
visible: #has_wx`,
  'Conditions': `// visible: is shown when the result is more than 0
// { is less than, } is more than, ** is and, || is or
visible: #hour24}=6**#hour24{18
visible: #hour24{6||#hour24}=18
night = #hour24{6||#hour24}=18
ifelse(#night,'Moon','Sun')
ifelse(#sms_unread_count}0,#sms_unread_count+' new','No messages')
eq(#battery_state,1)+eq(#battery_state,3)`,
};

function loadScript() {
  try {
    return localStorage.getItem(SCRIPT_KEY) ?? EXAMPLES['Mixed basics'];
  } catch {
    return EXAMPLES['Mixed basics'];
  }
}

// ---------- the editor: colours and autocomplete ----------

interface LexState {
  inTag: boolean;
  quote: string | null;
}

const playgroundLanguage = StreamLanguage.define<LexState>({
  startState: () => ({ inTag: false, quote: null }),
  token(stream, state) {
    if (stream.sol()) {
      state.inTag = false;
      state.quote = null;
      if (stream.match(/^\s*\/\/.*/)) return 'comment';
      if (stream.match(/^\s*(date|fmt|visible)\s*:/i)) return 'keyword';
      if (stream.match(/^\s*[A-Za-z_][\w.]*(?=\s*=(?!=))/)) return 'def';
      if (stream.match(/^\s*<\/?[\w.:-]+/)) {
        state.inTag = true;
        return 'tag';
      }
    }
    if (state.inTag && !state.quote) {
      if (stream.match(/^[\w.:-]+(?=\s*=)/)) return 'attribute';
      if (stream.match('"')) {
        state.quote = '"';
        return 'meta';
      }
      if (stream.match(/^\/?>/)) return 'tag';
    }
    if (state.quote && stream.peek() === '"') {
      stream.next();
      state.quote = null;
      return 'meta';
    }
    if (stream.match(/^'[^']*'?/)) return 'string';
    if (stream.match(/^#[\w.]+/)) return 'variable';
    if (stream.match(/^@[\w.]+/)) return 'variable-2';
    if (stream.match(/^[A-Za-z_]\w*(?=\()/)) return 'builtin';
    if (stream.match(/^\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^(\*\*|\|\||[{}]=?|==|!=|[-+*/%!])/)) return 'operator';
    stream.next();
    return null;
  },
});

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: '#6b6e76', fontStyle: 'italic' },
    { tag: tags.keyword, color: '#ff8442', fontWeight: '600' },
    { tag: tags.definition(tags.variableName), color: '#e6c07b', fontWeight: '600' },
    { tag: tags.variableName, color: '#ffb86b' },
    { tag: tags.special(tags.variableName), color: '#7ee0a4' },
    { tag: tags.string, color: '#9ecbff' },
    { tag: tags.standard(tags.variableName), color: '#d6a6ff' },
    { tag: tags.number, color: '#ffb86b' },
    { tag: tags.operator, color: '#c9d1e0' },
    { tag: tags.tagName, color: '#f28b82' },
    { tag: tags.attributeName, color: '#e6c07b' },
    { tag: tags.meta, color: '#8c8f97' },
  ]),
);

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg-1)', color: 'var(--text)', height: '100%', fontSize: '13.5px' },
    '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)' },
    '.cm-line': { lineHeight: '26px' },
    '.cm-gutters': { backgroundColor: 'var(--bg-1)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
    '.cm-gutterElement': { lineHeight: '26px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--text-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(240,136,62,0.25) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-3)', border: '1px solid var(--line-strong)', borderRadius: '8px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: '12.5px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
    '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '10px', fontFamily: 'var(--font)', fontSize: '12px' },
    '.cm-completionInfo': { fontFamily: 'var(--font)', fontSize: '12px', padding: '6px 9px', maxWidth: '260px' },
  },
  { dark: true },
);

const BASIC_SETUP = { foldGutter: false, highlightActiveLine: true, autocompletion: false, bracketMatching: true, closeBrackets: true } as const;

const LINE_KINDS: Completion[] = [
  { label: 'date:', type: 'keyword', detail: 'a date pattern', info: 'date: d/M EE → like <DateTime format="d/M EE"/>', apply: 'date: ' },
  { label: 'fmt:', type: 'keyword', detail: 'format | paras', info: 'fmt: %d%% | #battery_level → like <Text format="%d%%" paras="#battery_level"/>', apply: 'fmt: ' },
  { label: 'visible:', type: 'keyword', detail: 'shown or hidden', info: 'visible: eq(#battery_state,1) → shown while charging', apply: 'visible: ' },
];

/** Autocomplete for variables (with what they hold now), functions, and line kinds at the start of a line. */
function completer(varsRef: React.RefObject<Map<string, string | number>>) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const v = ctx.matchBefore(/[#@][\w.]*/);
    if (v) {
      const vars = varsRef.current ?? new Map();
      const sigil = v.text[0];
      const options: Completion[] = [];
      for (const [name, value] of vars) {
        if (!/^[A-Za-z_][\w.]*$/.test(name) || name.endsWith('.bmp_width') || name.endsWith('.bmp_height') || name.startsWith('raw_') || name.startsWith('view_')) continue;
        const isText = typeof value === 'string' && value !== '' && Number.isNaN(Number(value));
        options.push({
          label: `${isText ? '@' : '#'}${name}`,
          detail: String(value === '' ? 'empty' : typeof value === 'number' ? +value.toFixed(2) : value).slice(0, 28),
          info: VAR_INFO[name],
          type: isText ? 'text' : 'variable',
          boost: ((sigil === '@') === isText ? 2 : 0) + (name in VAR_INFO ? 1 : 0),
        });
      }
      return { from: v.from, options, validFor: /^[#@][\w.]*$/ };
    }
    const w = ctx.matchBefore(/[A-Za-z_]\w*:?/);
    const before = w ? ctx.state.sliceDoc(Math.max(0, w.from - 1), w.from) : '';
    if (!w || /[#@\w.']/.test(before) || (w.text.length < 2 && !ctx.explicit)) return null;
    const lineStart = ctx.state.doc.lineAt(ctx.pos).from;
    const atStart = !ctx.state.sliceDoc(lineStart, w.from).trim();
    const fns: Completion[] = FUNC_INFO.map((f) => ({ label: f.name, detail: f.sig, info: f.desc, type: 'function', apply: f.insert }));
    return { from: w.from, options: atStart ? [...LINE_KINDS, ...fns] : fns };
  };
}

// ---------- output ----------

function Pill({ r }: { r: LineResult }) {
  if (r.kind === 'visible' || (r.kind === 'element' && r.shown !== undefined && r.type === null))
    return <span className={`try-vis ${r.shown ? 'is-on' : ''}`}>{r.shown ? <Eye /> : <EyeOff />} {r.shown ? 'shown' : 'hidden'}</span>;
  if (r.type === null) return null;
  return <span className={`try-pill ${r.text === '' ? 'is-empty' : ''} ${r.type === 'number' ? 'is-num' : ''}`}>{r.text === '' ? 'empty' : r.text}</span>;
}

const hasRow = (r: LineResult | undefined) => !!r && r.kind !== 'empty' && r.kind !== 'comment' && r.kind !== 'close';

function Row({ r, onCopy, copied }: { r: LineResult; onCopy: () => void; copied: boolean }) {
  if (!hasRow(r)) return null;
  return (
    <>
      {r.kind === 'define' && <span className="try-name">{r.name} =</span>}
      {(r.kind === 'element' || r.kind === 'binder') && <span className="try-tag">&lt;{r.tag === 'ContentProviderBinder' ? 'Binder' : r.tag}&gt;</span>}
      {r.kind === 'define' && r.tag === 'Variable' && <span className="try-tag">column</span>}
      {r.kind === 'date' && <span className="try-tag">date</span>}
      {r.kind === 'format' && <span className="try-tag">fmt</span>}
      <Pill r={r} />
      {r.kind === 'element' && r.shown !== undefined && r.type !== null && <span className={`try-vis is-small ${r.shown ? 'is-on' : ''}`}>{r.shown ? <Eye /> : <EyeOff />}</span>}
      {r.extras?.map(([k, v]) => (
        <span key={k} className="try-extra">
          {k} = {v}
        </span>
      ))}
      {r.problems.length > 0 && (
        <span className="try-warn" title={r.problems.join('\n')}>
          <AlertTriangle /> {r.problems[0]}
        </span>
      )}
      {r.xml && (
        <button className="try-copy" title={`Copy as MAML: ${r.xml}`} onClick={onCopy}>
          {copied ? <Check /> : <Copy />}
        </button>
      )}
    </>
  );
}

const NO_FILES = new Map<string, FileInfo>();

function PhoneOutput({ script, results, units, now, overrides, onScript }: { script: string; results: LineResult[]; units: Unit[]; now: Date; overrides: Record<string, string | number>; onScript: (s: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 500 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hasLock = useHasLockLayout();
  const [mode, setMode] = usePhoneMode();
  const onTheme = mode === 'theme' && hasLock;
  const layout = useMemo(() => scriptLayout(script, results, units), [script, results, units]);
  const xml = layout.xml;
  // Dragging a piece of the script writes its new x / y into the code. Pieces of
  // the theme (and visible: markers) only move in the drawing, for a look.
  const onMove = (ords: number[], dx: number, dy: number, elements: Element[]) => {
    const sizes = layout.pieces.map((p) => countElements(p.xml));
    const first = elements.length - sizes.reduce((a, b) => a + b, 0);
    let next = script;
    const done: number[] = [];
    for (const o of ords) {
      let at = first;
      for (let i = 0; i < sizes.length; i++) {
        if (o >= at && o < at + sizes[i]) {
          if (layout.pieces[i].kind !== 'visible') {
            next = moveInScript(next, layout.pieces[i], o - at, dx, dy);
            done.push(o);
          }
          break;
        }
        at += sizes[i];
      }
    }
    if (next !== script) onScript(next);
    return done;
  };
  const mv = usePhoneMoves(`${onTheme}|${(xml.match(/<ContentProviderBinder\b/g) ?? []).length}`, onMove);
  const moves = mv.moves;
  const transform = useCallback((text: string) => applyMoves(overlayLockscreen(text, xml), moves), [xml, moves]);
  const scene = useMemo(() => {
    if (onTheme) return null;
    const doc = new DOMParser().parseFromString(applyMoves(xml, moves), 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    const elements = Array.from(doc.getElementsByTagName('*'));
    try {
      return { built: buildScene(doc, new Map(elements.map((e, i) => [e, i])), { phone: 20 / 9, dir: '', files: NO_FILES, now, t: null, slot: 'main', overrides }), elements };
    } catch {
      return null;
    }
  }, [xml, onTheme, now, overrides, moves]);
  const k = scene ? Math.min((size.w - 40) / scene.built.w, (size.h - 110) / scene.built.h) : 0;
  return (
    <div className="try-phone" ref={box}>
      <div className="try-phonebar">
        <AlignToggle />
        <PhoneSwitch mode={onTheme ? 'theme' : 'blank'} onChange={setMode} hasTheme={hasLock} />
      </div>
      {onTheme ? (
        <div className="try-theme">
          <ThemePhone transform={transform} now={now} overrides={overrides} pick={mv.canvas} />
        </div>
      ) : scene ? (
        <div className="try-screen maml-movable" style={{ width: scene.built.w * k, height: scene.built.h * k }}>
          <MamlCanvas scene={scene.built} scale={k} {...mv.canvas(scene.elements)} />
        </div>
      ) : (
        <p className="muted">An element line isn’t valid XML yet, so the screen can’t be drawn. The Results tab shows which.</p>
      )}
      <p className="faint try-phone-note">
        {onTheme
          ? 'Your script over your theme’s lock screen. Dragging your pieces updates their x and y in the code; the theme’s own pieces only move here, for a look.'
          : 'Every line on one screen. Drag a piece (or nudge it with the arrow keys) and its x and y change in the code; a formula line becomes the <Text> it draws.'}
        {mv.moved && (
          <>
            {' '}
            <button className="link-btn" onClick={mv.reset}>
              Put back
            </button>
          </>
        )}
      </p>
    </div>
  );
}

// ---------- the page ----------

const STATES: [number, string][] = [
  [0, 'Normal'],
  [1, 'Charging'],
  [3, 'Full'],
];
const WEATHER: [string, number][] = [
  ['Clear', 18],
  ['Rain', 9],
  ['Cloudy', 14],
  ['Snow', -2],
];

export function TryPlayground() {
  const { tryText, nonce } = useGuide();
  const [script, setScript] = useState(loadScript);
  const [hour, setHour] = useState(21);
  const [minute, setMinute] = useState(5);
  const [battery, setBattery] = useState(82);
  const [state, setStateV] = useState(0);
  const [weather, setWeather] = useState(0);
  const [tab, setTab] = useState<'results' | 'phone'>('results');
  const [rows, setRows] = useState<{ top: number; height: number }[]>([]);
  const [contentHeight, setContentHeight] = useState(0);
  const [active, setActive] = useState(1);
  const [copied, setCopied] = useState<number | null>(null);
  const [live, setLive] = useState(() => {
    try {
      return localStorage.getItem(LIVE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [liveData, setLiveData] = useState<LiveData | null>(() => cachedLiveData());
  const [liveState, setLiveState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [clock, setClock] = useState(() => new Date());
  const [realBattery, setRealBattery] = useState<{ level: number; charging: boolean } | null>(null);
  const view = useRef<EditorView | null>(null);
  const out = useRef<HTMLDivElement>(null);
  const varsRef = useRef<Map<string, string | number>>(new Map());

  // A formula sent from elsewhere (a Try button, a formula clicked in the guide) becomes a new line.
  const handled = useRef(nonce);
  useEffect(() => {
    if (!tryText || handled.current === nonce) return;
    handled.current = nonce;
    setScript((s) => (s.trimEnd() ? `${s.trimEnd()}\n${tryText}` : tryText));
  }, [tryText, nonce]);

  useEffect(() => {
    try {
      localStorage.setItem(SCRIPT_KEY, script);
    } catch {
      /* storage unavailable */
    }
  }, [script]);

  // Live: the real clock, this computer's battery when the system reports one, and the weather where you are.
  useEffect(() => {
    try {
      localStorage.setItem(LIVE_KEY, live ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    if (!live) return;
    setClock(new Date());
    const tick = window.setInterval(() => setClock(new Date()), 15_000);
    let battery: { level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } | null = null;
    const read = () => battery && setRealBattery({ level: Math.round(battery.level * 100), charging: battery.charging });
    const nav = navigator as Navigator & { getBattery?: () => Promise<typeof battery> };
    void nav.getBattery?.().then((b) => {
      battery = b;
      read();
      b?.addEventListener('levelchange', read);
      b?.addEventListener('chargingchange', read);
    }).catch(() => undefined);
    if (!cachedLiveData()) void refreshLive();
    return () => {
      window.clearInterval(tick);
      battery?.removeEventListener('levelchange', read);
      battery?.removeEventListener('chargingchange', read);
    };
  }, [live]);

  async function refreshLive() {
    setLiveState({ loading: true, error: null });
    try {
      setLiveData(await fetchLiveData());
      setLiveState({ loading: false, error: null });
    } catch (e) {
      setLiveState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const now = useMemo(() => (live ? clock : new Date(2026, 2, 17, hour, minute, 7)), [live, clock, hour, minute]);
  const simVars = useMemo(() => {
    const [desc, temp] = WEATHER[weather];
    const sim = { battery_level: battery, battery_state: state, weather_description: desc, weather_temperature: `${temp}℃`, weather_temp: temp };
    if (!live) return sim;
    const out: Record<string, string | number> = { ...sim, ...(liveData ? liveVars(liveData) : {}) };
    if (realBattery) {
      out.battery_level = realBattery.level;
      out.battery_state = realBattery.charging ? (realBattery.level >= 100 ? 3 : 1) : 0;
    }
    return out;
  }, [battery, state, weather, live, liveData, realBattery]);
  const columns = useMemo(() => (live && liveData ? { ...SAMPLE_COLUMNS, ...liveColumns(liveData) } : SAMPLE_COLUMNS), [live, liveData]);
  const base = useMemo(() => sampleVars(now, simVars), [now, simVars]);
  const { results, vars, units } = useMemo(() => runScript(script, base, now, columns), [script, base, now, columns]);
  varsRef.current = vars;
  const overrides = useMemo(() => Object.fromEntries(vars) as Record<string, string | number>, [vars]);

  const extensions = useMemo(
    () => [
      playgroundLanguage,
      highlight,
      theme,
      autocompletion({ override: [completer(varsRef)], icons: false, activateOnTyping: true }),
      findExtension,
      keymap.of([
        {
          key: 'Mod-h',
          run: (v) => {
            openSearchPanel(v);
            showReplace(v);
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.geometryChanged || u.viewportChanged || u.heightChanged) measure(u.view);
        if (u.selectionSet || u.docChanged) setActive(u.state.doc.lineAt(u.state.selection.main.head).number);
      }),
    ],
    [],
  );

  function measure(v: EditorView) {
    const pad = v.documentPadding.top;
    const list: { top: number; height: number }[] = [];
    for (let i = 1; i <= v.state.doc.lines; i++) {
      const b = v.lineBlockAt(v.state.doc.line(i).from);
      list.push({ top: b.top + pad, height: b.height });
    }
    setRows(list);
    setContentHeight(v.contentHeight);
  }

  // Keep the output scrolled with the editor.
  useEffect(() => {
    const v = view.current;
    if (!v || tab !== 'results') return;
    const sync = () => {
      if (out.current) out.current.scrollTop = v.scrollDOM.scrollTop;
    };
    sync();
    v.scrollDOM.addEventListener('scroll', sync);
    return () => v.scrollDOM.removeEventListener('scroll', sync);
  }, [tab, rows.length]);

  const goToLine = (i: number) => {
    const v = view.current;
    if (!v) return;
    const line = v.state.doc.line(i + 1);
    v.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
    v.focus();
  };
  const copy = (i: number, xml: string) =>
    void navigator.clipboard?.writeText(xml).then(() => {
      setCopied(i);
      window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1300);
    });

  const current = results[active - 1];
  const counts = results.reduce((n, r) => n + (hasRow(r) ? 1 : 0), 0);

  return (
    <div className="try">
      <div className="try-bar">
        <button className={`btn btn-sm try-live ${live ? 'is-on' : ''}`} aria-pressed={live} onClick={() => setLive((v) => !v)} title="Live: the real time, this computer's battery, and the weather where you are. Asks ipwho.is for your approximate city (from your IP address) and open-meteo.com for its weather. Nothing else is sent.">
          <span className="try-live-dot" /> Live
        </button>
        {live ? (
          <span className="try-live-info">
            <span className="mono">
              {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
            </span>
            <span>{realBattery ? `${realBattery.level}%${realBattery.charging ? ' · charging' : ''}` : `${battery}% (no battery reported)`}</span>
            {liveState.loading ? (
              <span className="faint">
                <Loader2 className="spin" /> Getting the weather…
              </span>
            ) : liveData ? (
              <span title={`From open-meteo.com, ${new Date(liveData.fetchedAt).toLocaleTimeString()}`}>
                <MapPin /> {liveData.city} · {liveData.description} {Math.round(liveData.temp)}℃
              </span>
            ) : (
              <span className="try-live-err">{liveState.error ? `No live weather: ${liveState.error}. Using sample weather.` : 'Sample weather'}</span>
            )}
            <button className="tb-icon" title="Get the weather again" aria-label="Refresh live data" disabled={liveState.loading} onClick={() => void refreshLive()}>
              <RefreshCw />
            </button>
          </span>
        ) : (
          <>
          <label className="try-sim">
            <span className="mono">
              {String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')}
            </span>
            <input type="range" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="Hour" />
            <input type="range" min={0} max={59} value={minute} onChange={(e) => setMinute(Number(e.target.value))} aria-label="Minute" className="try-min" />
          </label>
          <label className="try-sim">
            <span className="mono">{battery}%</span>
            <input type="range" min={1} max={100} value={battery} onChange={(e) => setBattery(Number(e.target.value))} aria-label="Battery level" />
          </label>
          <div className="segmented">
            {STATES.map(([v, label]) => (
              <button key={v} aria-pressed={state === v} onClick={() => setStateV(v)}>
                {label}
              </button>
            ))}
          </div>
          <select className="select" value={weather} onChange={(e) => setWeather(Number(e.target.value))} aria-label="Weather">
            {WEATHER.map(([d, t], i) => (
              <option key={d} value={i}>
                {d} {t}℃
              </option>
            ))}
          </select>
          </>
        )}
        <span className="grow" />
        <select className="select" value="" onChange={(e) => e.target.value && setScript(EXAMPLES[e.target.value])} aria-label="Load an example">
          <option value="">Examples…</option>
          {Object.keys(EXAMPLES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button className="tb-icon" title="Find and replace (Ctrl+F · Ctrl+H)" aria-label="Find" onClick={() => view.current && openSearchPanel(view.current)}>
          <Search />
        </button>
        <button className="tb-icon" title="Start again with the basics" aria-label="Reset" onClick={() => setScript(EXAMPLES['Mixed basics'])}>
          <RotateCcw />
        </button>
      </div>

      <div className="try-split">
        <section className="try-code" aria-label="Code">
          <div className="try-head">
            <strong>Code</strong>
            <span className="faint">one thing per line, or a MAML block · @ or # for values · Ctrl+Space suggestions · Ctrl+F find</span>
          </div>
          <div className="try-editor">
            <CodeMirror
              value={script}
              height="100%"
              theme="none"
              basicSetup={BASIC_SETUP}
              extensions={extensions}
              onChange={setScript}
              onCreateEditor={(v) => {
                view.current = v;
                measure(v);
              }}
            />
          </div>
        </section>

        <section className="try-out" aria-label="Output">
          <div className="try-head">
            <div className="segmented">
              <button aria-pressed={tab === 'results'} onClick={() => setTab('results')}>
                <ListTree /> Results
              </button>
              <button aria-pressed={tab === 'phone'} onClick={() => setTab('phone')}>
                <Smartphone /> Phone
              </button>
            </div>
            <span className="faint">{counts} result{counts === 1 ? '' : 's'}</span>
          </div>
          {tab === 'results' ? (
            <div className="try-rows" ref={out} onWheel={(e) => view.current && (view.current.scrollDOM.scrollTop += e.deltaY)}>
              <div style={{ height: contentHeight + 40, position: 'relative' }}>
                {results.map((r, i) =>
                  rows[i] && hasRow(r) ? (
                    <div key={i} className={`try-row ${active === i + 1 ? 'is-active' : ''}`} style={{ top: rows[i].top, height: rows[i].height }} onClick={() => goToLine(i)}>
                      <span className="try-ln">{i + 1}</span>
                      <Row r={r} copied={copied === i} onCopy={() => r.xml && copy(i, r.xml)} />
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          ) : (
            <PhoneOutput script={script} results={results} units={units} now={now} overrides={overrides} onScript={setScript} />
          )}
        </section>
      </div>

      <div className="try-foot">
        {current && current.problems.length > 0 ? (
          <span className="try-foot-warn">
            <AlertTriangle /> Line {active}: {current.problems.join(' ')}
          </span>
        ) : (
          <span className="faint">
            <code>formula</code> · <code>date: d/M EE</code> · <code>fmt: %d%% | #battery_level</code> · <code>visible: condition</code> · <code>name = formula</code> · <code>&lt;Text …/&gt;</code> · <code>// comment</code>
          </span>
        )}
      </div>
    </div>
  );
}
