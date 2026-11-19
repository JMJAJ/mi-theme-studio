// AI assistant chat. The same conversation shows as a side panel next to any
// section, or full screen as its own section.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  CornerDownRight,
  FileSearch,
  Loader2,
  Maximize2,
  Minimize2,
  PenLine,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Square,
  TriangleAlert,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { parseInline, parseMarkdown, type Inline } from '../../lib/markdown';
import { providerPreset } from '../../lib/aiProviders';
import { getState, setState, toast, updateLayout, useStore } from '../../state/store';
import { goTo, openFile, revealInExplorer, revealInFile } from '../../state/actions';
import { answerApproval, isConfigured, loadAiSettings, newChat, sendMessage, stopAssistant, updateAiSettings, useAssistant, type ChatItem } from '../../state/assistant';
import { WRITE_TOOLS, type EditLocation } from '../../state/assistantTools';
import { fileName } from '../../lib/paths';

const openAiSettings = () => setState({ dialog: { type: 'settings', section: 'ai' } });

// ---------- markdown ----------

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{n.v}</Fragment>;
          case 'code':
            return <code key={i}>{n.v}</code>;
          case 'b':
            return (
              <strong key={i}>
                <Inlines nodes={n.v} />
              </strong>
            );
          case 'i':
            return (
              <em key={i}>
                <Inlines nodes={n.v} />
              </em>
            );
          case 'a':
            return (
              <span key={i} className="ai-link" title={n.href}>
                <Inlines nodes={n.v} />
              </span>
            );
          case 'img':
            return null;
        }
      })}
    </>
  );
}

const Md = ({ src }: { src: string }) => <Inlines nodes={parseInline(src)} />;

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang || 'code'}</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="ai-md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return (
              <div key={i} className={`ai-h ai-h${Math.min(b.level, 3)}`}>
                <Md src={b.text} />
              </div>
            );
          case 'p':
            return (
              <p key={i}>
                <Md src={b.text} />
              </p>
            );
          case 'code':
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case 'ul':
          case 'ol': {
            const Tag = b.t;
            return (
              <Tag key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Md src={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'table':
            return (
              <div key={i} className="ai-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>
                          <Md src={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, j) => (
                          <td key={j}>
                            <Md src={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} />;
          case 'img':
            return null;
        }
      })}
    </div>
  );
}

// ---------- items ----------

function Diff({ text }: { text: string }) {
  return (
    <pre className="ai-diff">
      {text.split('\n').map((line, i) => (
        <span key={i} className={line.startsWith('+ ') ? 'is-add' : line.startsWith('- ') ? 'is-del' : line.startsWith('@@') ? 'is-hunk' : ''}>
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

/** Open the file and flash the changed line, the same way Problems does. */
function goToEdit(l: EditLocation) {
  if (!getState().fileIndex.has(l.path)) {
    toast('warning', `${fileName(l.path)} is no longer in the theme.`);
    return;
  }
  // From the full-screen chat, keep the conversation beside the editor.
  if (getState().section === 'assistant') updateLayout({ assistant: true });
  openFile(l.path);
  revealInExplorer(l.path);
  revealInFile(l.path, l.line, l.column, l.length);
}

function Locations({ locations }: { locations: EditLocation[] }) {
  const files = new Set(locations.map((l) => l.path)).size;
  const shown = locations.slice(0, 6);
  return (
    <div className="ai-locs">
      {shown.map((l, i) => (
        <button key={i} className="ai-loc" title={`Open ${l.path} at line ${l.line}`} onClick={() => goToEdit(l)}>
          <CornerDownRight />
          {files > 1 ? `${fileName(l.path)}:` : ''}
          {l.endLine > l.line ? `Lines ${l.line}–${l.endLine}` : `Line ${l.line}`}
        </button>
      ))}
      {locations.length > shown.length && <span className="faint">+{locations.length - shown.length} more</span>}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { role: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const write = WRITE_TOOLS.has(item.name);
  const Icon = item.status === 'running' ? Loader2 : item.status === 'error' ? TriangleAlert : item.status === 'declined' ? XCircle : write ? PenLine : item.name === 'check_theme' ? Wrench : FileSearch;
  const pending = item.status === 'pending';
  const showDiff = !!item.proposal?.diff && (pending || open);
  return (
    <div className={`ai-tool is-${item.status} ${write ? 'is-write' : ''}`}>
      <button className="ai-tool-row" onClick={() => item.proposal?.diff && setOpen((v) => !v)} disabled={!item.proposal?.diff || pending}>
        <Icon className={item.status === 'running' ? 'spin' : ''} />
        <span className="ellipsis grow">{pending ? item.proposal?.title : (item.summary ?? item.label)}</span>
        {item.proposal?.diff && !pending && <ChevronDown className={open ? 'is-open' : ''} />}
      </button>
      {showDiff && <Diff text={item.proposal!.diff!} />}
      {item.status === 'done' && !!item.locations?.length && <Locations locations={item.locations} />}
      {pending && (
        <div className="ai-approve">
          <button className="btn btn-primary btn-sm" onClick={() => answerApproval(item.id, true)}>
            <Check /> Apply
          </button>
          <button className="btn btn-sm" onClick={() => answerApproval(item.id, false)}>
            <X /> Decline
          </button>
          <span className="faint">Undo any change later with Ctrl+Z</span>
        </div>
      )}
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  switch (item.role) {
    case 'user':
      return <div className="ai-msg ai-user">{item.text}</div>;
    case 'assistant':
      return (
        <div className="ai-msg ai-bot">
          {item.reasoning && (
            <details className="ai-reason" open={item.streaming && !item.text}>
              <summary>{item.streaming && !item.text ? 'Thinking…' : 'Thought'}</summary>
              <div>{item.reasoning}</div>
            </details>
          )}
          {item.text ? <Markdown text={item.text} /> : item.streaming && !item.reasoning ? <span className="ai-dots"><i /><i /><i /></span> : null}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'error':
      return (
        <div className="ai-error">
          <TriangleAlert />
          <span>{item.text}</span>
        </div>
      );
  }
}

// ---------- empty / setup ----------

const SUGGESTIONS = [
  'What is in this theme and what is missing?',
  'Add a big clock and date to the lock screen',
  'Check the theme and fix the problems you can',
  'Explain the file I have open',
  'Change the theme title and author',
];

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const settings = useAssistant((s) => s.settings);
  const project = useStore((s) => !!s.project);
  if (!isConfigured(settings)) {
    return (
      <div className="ai-welcome">
        <Sparkles className="ai-welcome-icon" />
        <h3>Set up the assistant</h3>
        <p>Choose an AI provider in Settings. Pollinations works instantly with no key; AIProxy uses your local pool; NVIDIA, OpenRouter, Gemini and Groq have free keys.</p>
        <button className="btn btn-primary" onClick={openAiSettings}>
          <Settings2 /> Open AI settings
        </button>
      </div>
    );
  }
  return (
    <div className="ai-welcome">
      <Sparkles className="ai-welcome-icon" />
      <h3>How can I help with your theme?</h3>
      <p>{project ? 'I can read, explain and edit the open theme. You approve each change, and Ctrl+Z undoes it.' : 'Open or create a theme to let me edit it. I can still answer questions.'}</p>
      <div className="ai-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="ai-chip" onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- composer ----------

function Composer({ autoFocus }: { autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const running = useAssistant((s) => s.running);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const send = () => {
    if (!text.trim() || running) return;
    if (sendMessage(text)) setText('');
  };
  return (
    <div className="ai-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder="Ask for help, or describe a change…"
        aria-label="Message the assistant"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {running ? (
        <button className="btn btn-icon ai-send" title="Stop" aria-label="Stop" onClick={stopAssistant}>
          <Square />
        </button>
      ) : (
        <button className="btn btn-primary btn-icon ai-send" title="Send (Enter)" aria-label="Send" disabled={!text.trim()} onClick={send}>
          <Send />
        </button>
      )}
    </div>
  );
}

// ---------- header ----------

function ModelChip() {
  const settings = useAssistant((s) => s.settings);
  const active = settings?.active ?? '';
  const preset = providerPreset(active);
  const model = settings?.providers[active]?.model;
  return (
    <button className="ai-model" onClick={openAiSettings} title="Change provider and model (Settings → AI)">
      <span className="ellipsis">{isConfigured(settings) ? model : 'Not set up'}</span>
      {preset && <span className="faint ellipsis">{preset.label.replace(/ \(.*\)$/, '')}</span>}
    </button>
  );
}

function Header({ mode }: { mode: 'side' | 'full' }) {
  const hasItems = useAssistant((s) => s.items.length > 0);
  const autoApply = useAssistant((s) => !!s.settings?.autoApply);
  return (
    <header className="ai-head">
      <Bot className="ai-head-icon" />
      <strong>Assistant</strong>
      <ModelChip />
      <span className="grow" />
      <button
        className={`tb-icon ${autoApply ? 'is-on' : ''}`}
        aria-pressed={autoApply}
        title={autoApply ? 'Edits apply right away (click to ask first)' : 'Asks before each edit (click to apply right away)'}
        onClick={() => void updateAiSettings({ autoApply: !autoApply })}
      >
        <PenLine />
      </button>
      <button className="tb-icon" title="New chat" aria-label="New chat" disabled={!hasItems} onClick={newChat}>
        <Plus />
      </button>
      {mode === 'side' ? (
        <>
          <button className="tb-icon" title="Full screen" aria-label="Open full screen" onClick={() => goTo('assistant')}>
            <Maximize2 />
          </button>
          <button className="tb-icon" title="Close (Ctrl+Shift+A)" aria-label="Close assistant" onClick={() => updateLayout({ assistant: false })}>
            <X />
          </button>
        </>
      ) : (
        <button
          className="tb-icon"
          title="Back to a side panel"
          aria-label="Show as side panel"
          onClick={() => {
            updateLayout({ assistant: true });
            goTo('design');
          }}
        >
          <Minimize2 />
        </button>
      )}
      <button className="tb-icon" title="AI settings" aria-label="AI settings" onClick={openAiSettings}>
        <Settings2 />
      </button>
    </header>
  );
}

// ---------- panel ----------

function Status() {
  const status = useAssistant((s) => s.status);
  const running = useAssistant((s) => s.running);
  if (!running || !status) return null;
  return (
    <div className="ai-status">
      <Loader2 className="spin" /> {status}
    </div>
  );
}

export function AssistantChat({ mode }: { mode: 'side' | 'full' }) {
  const items = useAssistant((s) => s.items);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (!useAssistant.getState().settings) void loadAiSettings();
  }, []);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  const body: ReactNode = items.length ? items.map((item) => <Message key={item.id} item={item} />) : <Welcome onPick={(t) => sendMessage(t)} />;
  return (
    <div className={`ai-panel ai-${mode}`}>
      <Header mode={mode} />
      <div
        className="ai-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="ai-list-inner">{body}</div>
      </div>
      <div className="ai-foot">
        <Status />
        <Composer autoFocus={mode === 'full'} />
      </div>
    </div>
  );
}

/** Full-screen section. */
export function AssistantView() {
  return <AssistantChat mode="full" />;
}
