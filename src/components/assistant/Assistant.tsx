// AI assistant chat. The same conversation shows as a side panel next to any
// section, or full screen as its own section.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownRight,
  FileSearch,
  History,
  LockKeyhole,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRight,
  PenLine,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  ShieldOff,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { parseInline, parseMarkdown, type Inline } from '../../lib/markdown';
import { providerPreset } from '../../lib/aiProviders';
import { getState, setState, toast, updateLayout, useStore } from '../../state/store';
import { goTo, openFile, revealInExplorer, revealInFile } from '../../state/actions';
import {
  answerApproval,
  changesSince,
  deleteChat,
  isConfigured,
  loadAiSettings,
  newChat,
  openChat,
  rewindTo,
  setPermissionMode,
  setReasoningEffort,
  sendMessage,
  stopAssistant,
  useAssistant,
  type ChatItem,
} from '../../state/assistant';
import { PERMISSION_INFO, PERMISSION_MODES, type PermissionMode } from '../../state/assistantPermissions';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../state/assistantReasoning';
import { WRITE_TOOLS, type EditLocation } from '../../state/assistantTools';
import { fileName } from '../../lib/paths';
import { relativeTime } from '../../lib/format';

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

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => toast('error', 'Could not copy to the clipboard.'),
    );
  };
  return [copied, copy] as const;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, copy] = useCopy(text);
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang || 'code'}</span>
        <button className="btn btn-ghost btn-sm" onClick={copy}>
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

function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopy(text);
  return (
    <button className="ai-act" title={copied ? 'Copied' : label} aria-label={label} onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </button>
  );
}

function UserMessage({ item }: { item: Extract<ChatItem, { role: 'user' }> }) {
  const running = useAssistant((s) => s.running);
  const project = useStore((s) => s.project);
  const changes = changesSince(item, project);
  const rewindTitle = changes?.length
    ? `Rewind to here: undo ${changes.length} theme change${changes.length === 1 ? '' : 's'} made since, and edit this message`
    : 'Rewind the chat to here and edit this message';
  return (
    <div className="ai-user-wrap">
      <div className="ai-msg ai-user">{item.text}</div>
      <div className="ai-acts">
        {item.at && <span className="faint">{relativeTime(item.at)}</span>}
        <CopyAction text={item.text} label="Copy prompt" />
        <button
          className={`ai-act ${changes?.length ? 'has-changes' : ''}`}
          title={rewindTitle}
          aria-label="Rewind to this message"
          disabled={running}
          onClick={() => void rewindTo(item.id).then(() => document.querySelector<HTMLTextAreaElement>('.ai-composer textarea')?.focus())}
        >
          <RotateCcw />
          {!!changes?.length && <span>{changes.length}</span>}
        </button>
      </div>
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  switch (item.role) {
    case 'user':
      return <UserMessage item={item} />;
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
          {item.text && !item.streaming && (
            <div className="ai-acts ai-acts-bot">
              <CopyAction text={item.text} label="Copy answer" />
            </div>
          )}
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
      <p>{project ? 'I can read and edit the open theme, process local images, and use terminal tools when the chat permission allows it. Theme changes are undoable with Ctrl+Z.' : 'Open or create a theme to let me edit it and import local files. Choose chat permissions beside the message box.'}</p>
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

// ---------- permission picker and composer ----------

function PermissionGlyph({ mode }: { mode: PermissionMode }) {
  if (mode === 'read-only') return <LockKeyhole />;
  if (mode === 'workspace') return <Pencil />;
  if (mode === 'supervised') return <ShieldCheck />;
  return <ShieldOff />;
}

function PermissionPicker() {
  const mode = useAssistant((s) => s.permissionMode);
  const [open, setOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PermissionMode | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = PERMISSION_INFO[previewMode ?? mode];

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) {
        setOpen(false);
        setPreviewMode(null);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setPreviewMode(null);
        trigger.current?.focus();
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', keydown);
    };
  }, [open]);

  return (
    <div className="ai-permissions" ref={host}>
      {open && (
        <div className="ai-permission-popover" role="dialog" aria-label="Assistant permissions">
          <strong className="ai-permission-title">Permissions</strong>
          <div className="ai-permission-options" role="group" aria-label="Choose assistant permissions">
            {PERMISSION_MODES.map((option) => (
              <button
                key={option}
                type="button"
                className={mode === option ? 'is-selected' : ''}
                aria-label={PERMISSION_INFO[option].label}
                aria-pressed={mode === option}
                title={PERMISSION_INFO[option].label}
                onMouseEnter={() => setPreviewMode(option)}
                onMouseLeave={(event) => {
                  if (document.activeElement !== event.currentTarget) setPreviewMode(null);
                }}
                onFocus={() => setPreviewMode(option)}
                onBlur={(event) => {
                  if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setPreviewMode(null);
                }}
                onClick={() => {
                  setPermissionMode(option);
                  setPreviewMode(null);
                  setOpen(false);
                }}
              >
                <PermissionGlyph mode={option} />
              </button>
            ))}
          </div>
          <div className="ai-permission-detail">
            <strong>{selected.label}</strong>
            <p>{selected.description}</p>
          </div>
        </div>
      )}
      <button
        ref={trigger}
        className={`ai-permission-trigger ${mode === 'full-access' ? 'is-full' : ''}`}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setPreviewMode(null);
          setOpen((value) => !value);
        }}
      >
        <PermissionGlyph mode={mode} />
        <span>{selected.label}</span>
        <ChevronUp className={open ? 'is-open' : ''} />
      </button>
    </div>
  );
}

function ReasoningPicker() {
  const effort = useAssistant((s) => s.reasoningEffort);
  return (
    <label
      className="ai-reasoning-control"
      title="Auto leaves reasoning to the model. Other levels are sent as reasoning_effort to compatible providers."
    >
      <Brain aria-hidden="true" />
      <select
        className="ai-reasoning-select"
        aria-label="Reasoning effort"
        value={effort}
        onChange={(event) => setReasoningEffort(event.currentTarget.value as ReasoningEffort)}
      >
        {REASONING_EFFORTS.map((level) => (
          <option key={level} value={level}>{level === 'auto' ? 'Auto' : level[0].toUpperCase() + level.slice(1)}</option>
        ))}
      </select>
    </label>
  );
}

function Composer({ autoFocus }: { autoFocus?: boolean }) {
  const text = useAssistant((s) => s.draft);
  const setText = (draft: string) => useAssistant.setState({ draft });
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
      <div className="ai-composer-foot">
        <PermissionPicker />
        <ReasoningPicker />
        <span className="grow" />
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

function Header({ mode, history, onHistory }: { mode: 'side' | 'full'; history: boolean; onHistory: () => void }) {
  const hasItems = useAssistant((s) => s.items.length > 0);
  const phoneOpen = useStore((s) => s.layout.phone);
  return (
    <header className="ai-head">
      <Bot className="ai-head-icon" />
      <strong>Assistant</strong>
      <ModelChip />
      <span className="grow" />
      <button
        className={`tb-icon ${phoneOpen ? 'is-on' : ''}`}
        aria-pressed={phoneOpen}
        title={phoneOpen ? 'Hide phone preview' : 'Show phone preview'}
        aria-label={phoneOpen ? 'Hide phone preview' : 'Show phone preview'}
        onClick={() => updateLayout({ phone: !phoneOpen })}
      >
        <PanelRight />
      </button>
      <button className={`tb-icon ${history ? 'is-on' : ''}`} aria-pressed={history} title="Chat history" aria-label="Chat history" onClick={onHistory}>
        <History />
      </button>
      <button className="tb-icon" title="New chat" aria-label="New chat" disabled={!hasItems && !history} onClick={() => void newChat().then(() => history && onHistory())}>
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

function ChatHistory({ onClose }: { onClose: () => void }) {
  const chats = useAssistant((s) => s.chats);
  const current = useAssistant((s) => s.chatId);
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const shown = query ? chats.filter((c) => `${c.title} ${c.project ?? ''}`.toLowerCase().includes(query)) : chats;
  return (
    <div className="ai-history">
      <div className="ai-history-search">
        <Search />
        <input autoFocus value={filter} placeholder="Search chats" aria-label="Search chats" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
      </div>
      <div className="ai-history-list">
        {!shown.length && <div className="ai-history-empty">{chats.length ? 'No chats match.' : 'No saved chats yet. Chats are kept here as you go.'}</div>}
        {shown.map((c) => (
          <div key={c.id} className={`ai-history-row ${c.id === current ? 'is-current' : ''}`}>
            <button className="ai-history-open" onClick={() => void openChat(c.id).then(onClose)}>
              <span className="ellipsis">{c.title}</span>
              <span className="faint ellipsis">
                {c.project ? `${c.project} · ` : ''}
                {relativeTime(c.updatedAt)}
              </span>
            </button>
            <button className="ai-act" title="Delete chat" aria-label={`Delete chat ${c.title}`} onClick={() => void deleteChat(c.id)}>
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AssistantChat({ mode }: { mode: 'side' | 'full' }) {
  const items = useAssistant((s) => s.items);
  const [history, setHistory] = useState(false);
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
      <Header mode={mode} history={history} onHistory={() => setHistory((v) => !v)} />
      {history ? (
        <ChatHistory
          onClose={() => {
            stick.current = true;
            setHistory(false);
          }}
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

/** Full-screen section. */
export function AssistantView() {
  return <AssistantChat mode="full" />;
}
