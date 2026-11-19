// The Guide's recipe gallery: working lock screen widgets drawn live by the
// editor's own preview, set up with plain controls, then added to the theme's
// lock screen in one click. The code they write is shown so people learn it.
import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Check, Copy, Move, Plus, RotateCcw, Search, X } from 'lucide-react';
import { evalNumber } from '../../lib/maml';
import { insertBlock, type LockBlock } from '../../lib/mamlBlocks';
import { blockCode, defaultSpot, RECIPE_COLORS, RECIPES, type Params, type Recipe } from '../../lib/mamlRecipes';
import { countElements } from '../../lib/playground';
import type { FileInfo } from '../../lib/types';
import { addToLockScreen } from '../../state/guide';
import { useStore } from '../../state/store';
import { Splitter } from '../common/Splitter';
import { XmlCode } from './GuideCode';
import { AlignToggle, buildScene, MamlCanvas, ThemePhone, useHasLockLayout } from './MamlPreview';
import { PhoneSwitch, usePhoneMode } from './PhoneSwitch';
import { applyMoves, usePhoneMoves } from './PhoneMoves';

/** What the simulator controls set: the moment, battery, weather, messages and alarm. */
interface Sim {
  hour: number;
  minute: number;
  battery: number;
  state: number;
  weather: number;
  unread: boolean;
  alarm: boolean;
}

const WEATHER: [string, number][] = [
  ['Clear', 18],
  ['Rain', 9],
  ['Cloudy', 14],
  ['Snow', -2],
];

function simNow(sim: Sim) {
  const d = new Date();
  d.setHours(sim.hour, sim.minute, 7, 0);
  return d;
}

function overrides(sim: Sim): Record<string, number | string> {
  const [desc, temp] = WEATHER[sim.weather];
  return {
    battery_level: sim.battery,
    battery_state: sim.state,
    sms_unread_count: sim.unread ? 3 : 0,
    call_missed_count: sim.unread ? 2 : 0,
    next_alarm_time: sim.alarm ? '07:30' : '',
    mts_weather_desc: desc,
    mts_weather_temp: temp,
    mts_weather_range: `${temp - 4}℃~${temp + 3}℃`,
    mts_weather_city: 'Your city',
    mts_has_weather: 1,
  };
}

const NO_FILES = new Map<string, FileInfo>();

/** A block drawn by the real preview engine, fitted into width × height. */
function BlockView({ block, sim, width, height, mv }: { block: LockBlock; sim: Sim; width: number; height: number; mv?: ReturnType<typeof usePhoneMoves> }) {
  const moves = mv?.moves;
  const scene = useMemo(() => {
    const body = block.body(`${block.id}_1`).replace('{x}', '0').replace('{y}', '0');
    const plain = `<Lockscreen version="1" screenWidth="1080">${block.binder ? `<VariableBinders>${block.binder.xml}</VariableBinders>` : ''}${body}</Lockscreen>`;
    const xml = moves ? applyMoves(plain, moves) : plain;
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    const elements = Array.from(doc.getElementsByTagName('*'));
    try {
      const built = buildScene(doc, new Map(elements.map((e, i) => [e, i])), { phone: 20 / 9, dir: '', files: NO_FILES, now: simNow(sim), t: null, slot: 'main', overrides: overrides(sim) });
      const vis = doc.querySelector('Group')?.getAttribute('visibility');
      return { built, elements, hidden: !!vis && evalNumber(vis, built.vars, 1) <= 0 };
    } catch {
      return null;
    }
  }, [block, sim, moves]);
  const k = Math.min((width * 0.9) / block.w, (height * 0.82) / block.h, 0.6);
  return (
    <div className={`rc-view ${mv ? 'is-movable maml-movable' : ''}`} style={{ width, height }}>
      {scene && !scene.hidden && (
        <div style={{ position: 'absolute', left: (width - block.w * k) / 2, top: (height - block.h * k) / 2, width: scene.built.w * k, height: scene.built.h * k }}>
          <MamlCanvas scene={scene.built} scale={k} {...mv?.canvas(scene.elements)} />
        </div>
      )}
      {scene?.hidden && <span className="rc-hidden">Hidden right now · change the simulator above</span>}
    </div>
  );
}

/** Where the widget sits on the theme (its group's ordinal and top-left corner), before any drag. */
interface Place {
  ord: number;
  x: number;
  y: number;
}

/** The widget on the theme's own lock screen, a bit below the middle, for a look (nothing is saved). */
function OnTheme({ block, sim, width, mv, place }: { block: LockBlock; sim: Sim; width: number; mv: ReturnType<typeof usePhoneMoves>; place: MutableRefObject<Place | null> }) {
  const moves = mv.moves;
  const transform = useCallback(
    (text: string) => {
      const sw = Number(/<Lockscreen[^>]*screenWidth="(\d+)"/.exec(text)?.[1]) || 1080;
      const y = Math.round(sw * (20 / 9) * 0.42);
      const done = insertBlock(text, block, 0, sw, y);
      if (!done) return text;
      place.current = { ord: done.ord, x: Math.round((sw - (block.w * sw) / 1080) / 2), y };
      return applyMoves(done.text, moves);
    },
    [block, moves, place],
  );
  const now = useMemo(() => simNow(sim), [sim]);
  const over = useMemo(() => overrides(sim), [sim]);
  return (
    <div className="rc-theme" style={{ height: Math.round(Math.min(620, Math.max(320, width * 1.3))) }}>
      <ThemePhone transform={transform} now={now} overrides={over} pick={mv.canvas} />
    </div>
  );
}

function Controls({ recipe, params, onChange }: { recipe: Recipe; params: Params; onChange: (p: Params) => void }) {
  if (!recipe.params.length) return <p className="muted rc-none">Ready as it is. Restyle any part of it in the lock screen editor after adding it.</p>;
  const set = (key: string, v: Params[string]) => onChange({ ...params, [key]: v });
  return (
    <div className="rc-ctls">
      {recipe.params.map((p) => (
        <div key={p.key} className="rc-ctl">
          <div className="rc-label">
            {p.label}
            {p.type === 'range' && <span className="faint">{String(params[p.key])}</span>}
          </div>
          {p.type === 'choice' && (
            <div className="rc-chips">
              {p.options.map(([v, label]) => (
                <button key={v} className="chip" aria-pressed={params[p.key] === v} onClick={() => set(p.key, v)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {p.type === 'toggle' && (
            <button className="chip" aria-pressed={!!params[p.key]} onClick={() => set(p.key, !params[p.key])}>
              {params[p.key] ? <Check /> : null} {params[p.key] ? 'On' : 'Off'}
            </button>
          )}
          {p.type === 'range' && <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={Number(params[p.key])} onChange={(e) => set(p.key, Number(e.target.value))} />}
          {p.type === 'text' && <input className="input" value={String(params[p.key])} placeholder={p.placeholder} onChange={(e) => set(p.key, e.target.value)} />}
          {p.type === 'color' && (
            <div className="rc-swatches">
              {RECIPE_COLORS.map(([c, name]) => (
                <button key={c} title={name} aria-label={name} aria-pressed={params[p.key] === c} style={{ ['--c' as string]: `#${c.slice(3)}`, opacity: c.startsWith('#cc') ? 0.8 : 1 }} onClick={() => set(p.key, c)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const CATEGORIES = ['All', ...new Set(RECIPES.map((r) => r.category))];

const WIDTH_KEY = 'mts.guide.detailWidth.v1';
const MIN_WIDTH = 280;
const MAX_WIDTH = 760;
function loadWidth() {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= MIN_WIDTH && v <= MAX_WIDTH ? v : 360;
  } catch {
    return 360;
  }
}

export function RecipeGallery() {
  const project = useStore((s) => s.project);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [selected, setSelected] = useState(RECIPES[0].id);
  const [all, setAll] = useState<Record<string, Params>>(() => Object.fromEntries(RECIPES.map((r) => [r.id, { ...r.defaults }])));
  const [sim, setSim] = useState<Sim>({ hour: 21, minute: 5, battery: 82, state: 0, weather: 0, unread: false, alarm: true });
  const [copied, setCopied] = useState(false);
  const [width, setWidth] = useState(loadWidth);
  const resize = (w: number) => {
    setWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* storage unavailable */
    }
  };

  const q = query.trim().toLowerCase();
  const list = RECIPES.filter((r) => (category === 'All' || r.category === category) && (!q || `${r.title} ${r.hint} ${r.category} ${r.keywords}`.toLowerCase().includes(q)));
  const recipe = RECIPES.find((r) => r.id === selected) ?? RECIPES[0];
  const params = all[recipe.id];
  const blocks = useMemo(() => Object.fromEntries(RECIPES.map((r) => [r.id, r.block(all[r.id])])), [all]);
  const set = (patch: Partial<Sim>) => setSim((s) => ({ ...s, ...patch }));
  const hasLock = useHasLockLayout();
  const [mode, setMode] = usePhoneMode();
  const onTheme = mode === 'theme' && hasLock;
  const mv = usePhoneMoves(`${recipe.id}|${onTheme}`);
  const place = useRef<Place | null>(null);
  // What was dragged on the phone goes into the code and into what is added: the
  // widget's own spot, and any piece moved inside it. Pieces of the theme only move in the drawing.
  const widget = useMemo(() => {
    const b = blocks[recipe.id];
    const root = onTheme ? (place.current?.ord ?? -1) : 1 + (b.binder ? 1 + countElements(b.binder.xml) : 0);
    const size = countElements(b.body(`${b.id}_1`));
    const inside: Record<number, [number, number]> = {};
    for (const [k, d] of Object.entries(mv.moves)) {
      const o = Number(k);
      if (o > root && o < root + size) inside[o - root] = d;
    }
    const block = Object.keys(inside).length ? { ...b, body: (name: string) => applyMoves(b.body(name), inside) } : b;
    const base = onTheme && place.current ? { x: place.current.x, y: place.current.y } : defaultSpot(b);
    const d = mv.moves[root];
    const at = d ? { x: base.x + d[0], y: base.y + d[1] } : base;
    return { block, at, dragged: !!d };
  }, [blocks, recipe.id, mv.moves, onTheme]);
  const code = blockCode(widget.block, widget.at);

  return (
    <div className="rc">
      <div className="rc-main">
        <div className="rc-head">
          <div>
            <h1>Lock screen widgets</h1>
            <p className="muted">Pick one, adjust it, then add it to your lock screen. Each one is drawn by the same engine as the lock screen preview, and shows the code it writes.</p>
          </div>
          <div className="rc-search">
            <Search />
            <input className="input" placeholder="Date, weather, battery, messages…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search widgets" />
            {query && (
              <button className="tb-icon" aria-label="Clear search" onClick={() => setQuery('')}>
                <X />
              </button>
            )}
          </div>
          <div className="rc-cats">
            {CATEGORIES.map((c) => (
              <button key={c} className="chip" aria-pressed={c === category} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
          <div className="rc-sim">
            <span className="faint">Preview as</span>
            <label>
              <span className="mono">
                {String(sim.hour).padStart(2, '0')}:{String(sim.minute).padStart(2, '0')}
              </span>
              <input type="range" min={0} max={23} value={sim.hour} onChange={(e) => set({ hour: Number(e.target.value) })} aria-label="Hour" />
            </label>
            <label>
              <span className="mono">{sim.battery}%</span>
              <input type="range" min={1} max={100} value={sim.battery} onChange={(e) => set({ battery: Number(e.target.value) })} aria-label="Battery level" />
            </label>
            <div className="segmented">
              {(
                [
                  [0, 'Normal'],
                  [1, 'Charging'],
                  [3, 'Full'],
                ] as const
              ).map(([v, label]) => (
                <button key={v} aria-pressed={sim.state === v} onClick={() => set({ state: v })}>
                  {label}
                </button>
              ))}
            </div>
            <select className="select" value={sim.weather} onChange={(e) => set({ weather: Number(e.target.value) })} aria-label="Weather">
              {WEATHER.map(([d, t], i) => (
                <option key={d} value={i}>
                  {d} {t}℃
                </option>
              ))}
            </select>
            <button className="chip" aria-pressed={sim.unread} onClick={() => set({ unread: !sim.unread })}>
              3 messages, 2 missed calls
            </button>
            <button className="chip" aria-pressed={sim.alarm} onClick={() => set({ alarm: !sim.alarm })}>
              Alarm set
            </button>
          </div>
        </div>
        <div className="rc-grid">
          {list.map((r) => (
            <button key={r.id} className={`rc-card ${r.id === recipe.id ? 'is-on' : ''}`} onClick={() => setSelected(r.id)}>
              <BlockView block={blocks[r.id]} sim={sim} width={220} height={110} />
              <span className="rc-cap">
                <strong>{r.title}</strong>
                <span className="faint ellipsis">{r.hint}</span>
              </span>
            </button>
          ))}
          {list.length === 0 && <p className="muted">No widget matches “{query}”.</p>}
        </div>
      </div>

      <Splitter orientation="vertical" label="Resize the widget settings" value={width} min={MIN_WIDTH} max={MAX_WIDTH} direction={-1} onChange={resize} />
      <aside className="rc-detail" aria-label={recipe.title} style={{ width }}>
        <div className="faint rc-cat">{recipe.category}</div>
        <div className="rc-titlebar">
          <h2>{recipe.title}</h2>
          <div className="rc-phonebar">
            <AlignToggle />
            <PhoneSwitch mode={onTheme ? 'theme' : 'blank'} onChange={setMode} hasTheme={hasLock} />
          </div>
        </div>
        {onTheme ? (
          <OnTheme block={blocks[recipe.id]} sim={sim} width={width - 36} mv={mv} place={place} />
        ) : (
          <BlockView block={blocks[recipe.id]} sim={sim} width={width - 36} height={Math.round(Math.min(360, Math.max(160, (width - 36) * 0.56)))} mv={mv} />
        )}
        <div className="rc-movehint faint">
          <Move /> {onTheme ? 'Drag the widget (double-click for a piece inside it) and the code follows; it is added where you leave it. Your theme’s own pieces move only here, for a look.' : 'Drag the widget (double-click for a piece inside it) or nudge it with the arrow keys; the code below follows.'}
          {mv.moved && (
            <button className="link-btn" onClick={mv.reset}>
              Put back
            </button>
          )}
        </div>
        <Controls recipe={recipe} params={params} onChange={(p) => setAll((a) => ({ ...a, [recipe.id]: p }))} />
        <div className="rc-actions">
          <button className="btn btn-primary" onClick={() => addToLockScreen(widget.block, recipe.title, widget.dragged ? widget.at : undefined)} title={project ? 'Open the lock screen editor and add it to the page you are editing' : 'Open or create a theme first'}>
            <Plus /> Add to lock screen
          </button>
          <button
            className="btn"
            onClick={() =>
              void navigator.clipboard?.writeText(code).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              })
            }
          >
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy code'}
          </button>
          {recipe.params.length > 0 && (
            <button className="tb-icon" title="Back to the defaults" aria-label="Reset" onClick={() => setAll((a) => ({ ...a, [recipe.id]: { ...recipe.defaults } }))}>
              <RotateCcw />
            </button>
          )}
        </div>
        <div className="rc-label">The code it writes</div>
        <pre className="rc-code selectable">
          <XmlCode code={code} />
        </pre>
        {!project && <p className="faint rc-note">Open a theme to add widgets to its lock screen. You can still copy the code.</p>}
      </aside>
    </div>
  );
}
