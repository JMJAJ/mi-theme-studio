// The AI assistant: provider settings, the conversation, and the agent loop
// (ask the model, run the tools it calls, feed results back, repeat).
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { api, errorCode, errorMessage, newOpId } from '../lib/api';
import type { AiSettings, AiSettingsPatch, AiStreamDelta, AiToolCall } from '../lib/types';
import { chatModels, providerPreset } from '../lib/aiProviders';
import { confirmDialog, getState as appState, setState as setAppState, updateLayout } from './store';
import { historyGoto } from './actions';
import type { ProjectSnapshot } from '../lib/types';
import { TOOL_SPECS, WRITE_TOOLS, runTool, toolLabel, type EditLocation, type Proposal } from './assistantTools';
import { THEME_KNOWLEDGE, themeContext } from './assistantContext';

export type ChatItem =
  | {
      id: string;
      role: 'user';
      text: string;
      /** When it was sent, and where the theme's undo history stood then. */
      at?: number;
      checkpoint?: Checkpoint;
      /** Index in `messages` of this prompt, so a rewind can cut the model's history too. */
      msgIndex?: number;
    }
  | { id: string; role: 'assistant'; text: string; reasoning: string; streaming: boolean; model?: string }
  | {
      id: string;
      role: 'tool';
      name: string;
      label: string;
      status: 'running' | 'pending' | 'done' | 'error' | 'declined';
      summary?: string;
      proposal?: Proposal;
      /** Where the change landed, for "go to line" buttons. */
      locations?: EditLocation[];
    }
  | { id: string; role: 'error'; text: string };

/** The theme's state just before a prompt: the last applied history step. */
export interface Checkpoint {
  project: string;
  /** null = the package as it was opened. */
  id: number | null;
  atMs: number | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  project?: string;
}

/** OpenAI chat message. */
type ApiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface AssistantState {
  settings: AiSettings | null;
  models: string[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** The open conversation and the saved ones, newest first. */
  chatId: string;
  chats: ChatSummary[];
  items: ChatItem[];
  messages: ApiMessage[];
  /** Text in the message box (kept here so a rewind can put a prompt back). */
  draft: string;
  running: boolean;
  /** Short status under the conversation ("Thinking…", "Waiting for your OK"). */
  status: string | null;
  /** Tools turned off for this chat after the model refused them. */
  noTools: boolean;
}

const OLD_CHAT_KEY = 'mts.assistant.chat.v1';
const INDEX_KEY = 'mts.assistant.chats.v2';
const chatKey = (id: string) => `mts.assistant.chat.v2.${id}`;
const MAX_CHATS = 60;
const MAX_STEPS = 30;
/** Older tool results are shortened past this many characters of history. */
const HISTORY_BUDGET = 160_000;

type SavedChat = Pick<AssistantState, 'items' | 'messages'>;

const newChatId = () => `chat${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function readChat(id: string): SavedChat {
  const saved = readJson<SavedChat>(chatKey(id));
  if (!saved) return { items: [], messages: [] };
  // A reload ends any run: unfinished steps cannot resume.
  const items = (saved.items ?? []).map((i): ChatItem => (i.role === 'tool' && (i.status === 'running' || i.status === 'pending') ? { ...i, status: 'declined' } : i.role === 'assistant' ? { ...i, streaming: false } : i));
  return { items, messages: saved.messages ?? [] };
}

function chatTitle(items: ChatItem[]): string {
  const first = items.find((i) => i.role === 'user');
  const text = first?.role === 'user' ? first.text.replace(/\s+/g, ' ').trim() : '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || 'New chat';
}

function loadChats(): Pick<AssistantState, 'chatId' | 'chats' | 'items' | 'messages'> {
  let chats = readJson<ChatSummary[]>(INDEX_KEY) ?? [];
  // Move the single chat older versions kept into the list.
  const old = readJson<SavedChat>(OLD_CHAT_KEY);
  if (old) {
    try {
      localStorage.removeItem(OLD_CHAT_KEY);
      if (old.items?.length) {
        const id = newChatId();
        localStorage.setItem(chatKey(id), JSON.stringify(old));
        chats = [{ id, title: chatTitle(old.items), updatedAt: Date.now() }, ...chats];
        localStorage.setItem(INDEX_KEY, JSON.stringify(chats));
      }
    } catch {
      /* ignore */
    }
  }
  const last = chats[0];
  return last ? { chatId: last.id, chats, ...readChat(last.id) } : { chatId: newChatId(), chats, items: [], messages: [] };
}

export const useAssistant = create<AssistantState>(() => ({
  settings: null,
  models: [],
  modelsLoading: false,
  modelsError: null,
  ...loadChats(),
  draft: '',
  running: false,
  status: null,
  noTools: false,
}));

const get = useAssistant.getState;
const set = useAssistant.setState;

function writeIndex(chats: ChatSummary[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(chats));
  } catch {
    /* ignore */
  }
}

function forget(id: string) {
  try {
    localStorage.removeItem(chatKey(id));
  } catch {
    /* ignore */
  }
}

/** Save the open chat and move it to the top of the list. */
function saveChat(s: AssistantState = get()) {
  if (!s.items.length) {
    // Rewound to nothing: it is no longer a saved chat.
    if (s.chats.some((c) => c.id === s.chatId)) {
      forget(s.chatId);
      const chats = s.chats.filter((c) => c.id !== s.chatId);
      writeIndex(chats);
      set({ chats });
    }
    return;
  }
  const data = JSON.stringify({ items: s.items.slice(-400), messages: trimmed(s.messages) });
  // A huge chat simply is not remembered.
  if (data.length > 3_000_000) return;
  const previous = s.chats.find((c) => c.id === s.chatId);
  const summary: ChatSummary = { id: s.chatId, title: chatTitle(s.items), updatedAt: Date.now(), project: appState().project?.title || previous?.project };
  let chats = [summary, ...s.chats.filter((c) => c.id !== s.chatId)];
  for (const dropped of chats.slice(MAX_CHATS)) forget(dropped.id);
  chats = chats.slice(0, MAX_CHATS);
  // Out of space: forget the oldest chats until it fits.
  for (;;) {
    try {
      localStorage.setItem(chatKey(s.chatId), data);
      break;
    } catch {
      const oldest = chats.length > 1 ? chats.pop() : undefined;
      if (!oldest) return;
      forget(oldest.id);
    }
  }
  writeIndex(chats);
  set({ chats });
}

let saveTimer: number | undefined;
function flushSave() {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  saveChat();
}
useAssistant.subscribe((s, prev) => {
  if (s.chatId !== prev.chatId || (s.items === prev.items && s.messages === prev.messages)) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    saveChat();
  }, 400);
});
window.addEventListener('beforeunload', flushSave);

// ---- settings ----

export async function loadAiSettings() {
  try {
    const settings = await api.aiSettings();
    set({ settings });
    return settings;
  } catch {
    return null;
  }
}

export async function updateAiSettings(patch: AiSettingsPatch) {
  const settings = await api.aiSettingsUpdate(patch);
  set({ settings });
  return settings;
}

/** Switch provider, filling in its preset address and model the first time. */
export async function chooseProvider(id: string) {
  const preset = providerPreset(id);
  const current = get().settings?.providers[id];
  await updateAiSettings({
    active: id,
    provider: { id, baseUrl: current?.baseUrl || preset?.baseUrl || '', model: current?.model || preset?.model || '' },
  });
  set({ models: [], modelsError: null });
  if (id === 'aiproxy' && !current?.hasKey) await detectAiproxy();
  else void refreshModels();
}

export async function detectAiproxy() {
  const result = await api.aiDetectAiproxy();
  await loadAiSettings();
  if (result.models.length) set({ models: chatModels(result.models), modelsError: null });
  else set({ modelsError: result.running ? null : result.message });
  return result;
}

export async function refreshModels() {
  set({ modelsLoading: true, modelsError: null });
  try {
    const models = chatModels(await api.aiModels());
    set({ models });
    // Nothing picked yet: take the first one (a free one on OpenRouter).
    const s = get().settings;
    const active = s?.active;
    if (active && s && !s.providers[active]?.model && models.length) {
      const pick = (active === 'openrouter' && models.find((m) => m.endsWith(':free'))) || models[0];
      await updateAiSettings({ provider: { id: active, model: pick } });
    }
  } catch (error) {
    set({ models: [], modelsError: errorMessage(error) });
  } finally {
    set({ modelsLoading: false });
  }
}

export function activeModel(): string {
  const s = get().settings;
  return (s && s.providers[s.active]?.model) || '';
}

export function isConfigured(s: AiSettings | null = get().settings): boolean {
  if (!s?.active) return false;
  const p = s.providers[s.active];
  if (!p?.baseUrl || !p.model) return false;
  return !providerPreset(s.active)?.needsKey || p.hasKey;
}

// ---- conversation ----

let itemCounter = 0;
const itemId = () => `c${Date.now().toString(36)}${++itemCounter}`;

function patchItem(id: string, patch: Partial<ChatItem>) {
  set((s) => ({ items: s.items.map((i) => (i.id === id ? ({ ...i, ...patch } as ChatItem) : i)) }));
}

function pushItem(item: ChatItem) {
  set((s) => ({ items: [...s.items, item] }));
}

let currentRequest: string | null = null;
let streamTarget: string | null = null;
let stopped = false;
const approvals = new Map<string, (ok: boolean) => void>();

let listening = false;
function ensureListener() {
  if (listening) return;
  listening = true;
  void listen<AiStreamDelta>('ai-stream', ({ payload }) => {
    if (payload.requestId !== currentRequest || !streamTarget) return;
    const target = streamTarget;
    set((s) => ({
      items: s.items.map((i) =>
        i.id === target && i.role === 'assistant' ? { ...i, text: i.text + (payload.content ?? ''), reasoning: i.reasoning + (payload.reasoning ?? '') } : i,
      ),
      status: payload.tool ? toolLabel(payload.tool, '') : payload.content ? 'Writing…' : payload.reasoning ? 'Thinking…' : s.status,
    }));
  }).catch(() => {
    listening = false;
  });
}

async function systemPrompt(): Promise<string> {
  const autoApply = !!get().settings?.autoApply;
  return [
    'You are the assistant inside Mi Theme Studio, a desktop app for making MIUI/HyperOS theme packages (.mtz).',
    'You help the person design, explain, fix and build their theme. You can read and change the open theme with your tools.',
    '',
    THEME_KNOWLEDGE,
    '',
    'Rules:',
    '- The theme summary below is current; use it to find the right files. Read a file before editing it, and copy text exactly for edit_file (the "12| " line numbers in the summary are not part of the file).',
    '- Keep XML well-formed. Prefer small edit_file changes over rewriting whole files; keep the file\'s own style.',
    '- You cannot create or edit images, fonts or sounds; say so and point to the app feature (Design section) instead.',
    `- ${autoApply ? 'Changes apply right away' : 'Each change is shown to the person for approval before it applies'}; every change is undoable with Ctrl+Z. Saving the package is the person's job (Ctrl+S).`,
    '- After a large XML change, run check_theme. When you finish, say briefly what you changed and where.',
    '- Answer in the language the person writes in. Be brief and practical; use Markdown with code blocks for XML.',
    '',
    '=== The open theme right now ===',
    await themeContext(),
  ].join('\n');
}

/** Shorten old tool results so long chats stay within the model's context. */
function trimmed(messages: ApiMessage[]): ApiMessage[] {
  let total = messages.reduce((n, m) => n + (('content' in m && m.content) || '').length, 0);
  if (total <= HISTORY_BUDGET) return messages;
  const out = messages.slice();
  for (let i = 0; i < out.length - 6 && total > HISTORY_BUDGET; i++) {
    const m = out[i];
    if (m.role === 'tool' && m.content.length > 400) {
      total -= m.content.length - 60;
      out[i] = { ...m, content: `${m.content.slice(0, 60)}… [older result removed to save space]` };
    }
  }
  return out;
}

function approve(toolItem: string, proposal: Proposal): Promise<boolean> {
  if (get().settings?.autoApply) return Promise.resolve(true);
  patchItem(toolItem, { status: 'pending', proposal } as Partial<ChatItem>);
  set({ status: 'Waiting for your OK' });
  return new Promise((resolve) => approvals.set(toolItem, resolve));
}

export function answerApproval(toolItem: string, ok: boolean) {
  const resolve = approvals.get(toolItem);
  approvals.delete(toolItem);
  patchItem(toolItem, { status: ok ? 'running' : 'declined' } as Partial<ChatItem>);
  set({ status: ok ? 'Applying…' : 'Thinking…' });
  resolve?.(ok);
}

/** Seconds to wait when a provider says it is rate limiting, or null for other errors. */
export function retryDelay(error: unknown): number | null {
  if (errorCode(error) !== 'ai_http') return null;
  const message = errorMessage(error);
  const after = /retry (?:after|in) (\d+(?:\.\d+)?)\s*s/i.exec(message);
  if (after) return Math.min(90, Math.ceil(Number(after[1])) + 1);
  if (/HTTP 429|rate.?limit|limit reached|too many requests/i.test(message)) return 20;
  return null;
}

/** Ask the model, waiting out short rate limits (free tiers allow one reply every few seconds). */
async function chatWithRetry(requestId: string, body: object) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.aiChat(requestId, body);
    } catch (error) {
      const wait = retryDelay(error);
      if (wait === null || attempt >= 4 || stopped) throw error;
      for (let left = wait; left > 0 && !stopped; left--) {
        set({ status: `Provider is rate limiting; trying again in ${left} s…` });
        await new Promise((r) => window.setTimeout(r, 1000));
      }
      if (stopped) throw error;
      set({ status: 'Thinking…' });
    }
  }
}

/** Starts a turn; false when nothing was sent (empty, busy, or not set up). */
export function sendMessage(text: string): boolean {
  const content = text.trim();
  if (!content || get().running) return false;
  if (!get().settings) {
    // Settings still loading: check once they are in.
    void loadAiSettings().then(() => (isConfigured() ? runTurn(content) : setAppState({ dialog: { type: 'settings', section: 'ai' } })));
    return true;
  }
  if (!isConfigured()) {
    setAppState({ dialog: { type: 'settings', section: 'ai' } });
    return false;
  }
  void runTurn(content);
  return true;
}

async function runTurn(content: string) {
  if (get().running) return;
  ensureListener();
  stopped = false;
  pushItem({ id: itemId(), role: 'user', text: content, at: Date.now(), checkpoint: checkpointNow() ?? undefined, msgIndex: get().messages.length });
  set((s) => ({ messages: [...s.messages, { role: 'user', content }], running: true, status: 'Thinking…' }));

  try {
    for (let step = 0; step < MAX_STEPS && !stopped; step++) {
      const answerId = itemId();
      pushItem({ id: answerId, role: 'assistant', text: '', reasoning: '', streaming: true });
      streamTarget = answerId;
      currentRequest = newOpId('ai');
      const useTools = !get().noTools;
      const body = { messages: [{ role: 'system', content: await systemPrompt() }, ...trimmed(get().messages)], ...(useTools ? { tools: TOOL_SPECS } : {}) };
      let reply;
      try {
        reply = await chatWithRetry(currentRequest, body);
      } catch (error) {
        // Some models (small local ones) reject tools: carry on as plain chat.
        if (useTools && errorCode(error) === 'ai_http' && /tool|function/i.test(errorMessage(error))) {
          set((s) => ({ noTools: true, items: s.items.filter((i) => i.id !== answerId) }));
          pushItem({ id: itemId(), role: 'error', text: 'This model cannot use tools, so it can answer questions but not edit the theme. Pick another model in Settings → AI to let it make changes.' });
          step--;
          continue;
        }
        throw error;
      }
      // Stream events can trail the reply; the reply is the full text.
      patchItem(answerId, { text: reply.content, reasoning: reply.reasoning, streaming: false, model: reply.model ?? undefined } as Partial<ChatItem>);
      if (!reply.content && !reply.reasoning && (reply.cancelled || reply.toolCalls.length)) set((s) => ({ items: s.items.filter((i) => i.id !== answerId) }));
      const calls: AiToolCall[] = reply.cancelled ? [] : reply.toolCalls;
      set((s) => ({
        messages: [
          ...s.messages,
          calls.length
            ? { role: 'assistant', content: reply.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) }
            : { role: 'assistant', content: reply.content || (reply.cancelled ? '(stopped)' : '') },
        ],
      }));
      if (!calls.length) {
        if (!reply.content && !reply.cancelled) pushItem({ id: itemId(), role: 'error', text: `The model sent an empty answer${reply.finishReason ? ` (${reply.finishReason})` : ''}. Try again or pick another model.` });
        break;
      }

      for (const call of calls) {
        let outcome;
        const toolId = itemId();
        if (stopped) {
          outcome = { result: 'Stopped by the person.', ok: false, summary: 'Stopped' };
        } else {
          pushItem({ id: toolId, role: 'tool', name: call.name, label: toolLabel(call.name, call.arguments), status: 'running' });
          set({ status: toolLabel(call.name, call.arguments) });
          outcome = await runTool(call.name, call.arguments, { approve: (p) => approve(toolId, p) });
          const declined = WRITE_TOOLS.has(call.name) && !outcome.ok && /declined/i.test(outcome.summary);
          patchItem(toolId, { status: declined ? 'declined' : outcome.ok ? 'done' : 'error', summary: outcome.summary, locations: outcome.locations } as Partial<ChatItem>);
        }
        set((s) => ({ messages: [...s.messages, { role: 'tool', tool_call_id: call.id, content: outcome.result }] }));
      }
      set({ status: 'Thinking…' });
      if (step === MAX_STEPS - 1) pushItem({ id: itemId(), role: 'error', text: `Stopped after ${MAX_STEPS} steps. Say "continue" to let it keep going.` });
    }
  } catch (error) {
    pushItem({ id: itemId(), role: 'error', text: errorMessage(error) });
    set((s) => ({ items: s.items.filter((i) => !(i.role === 'assistant' && i.streaming && !i.text)) }));
  } finally {
    currentRequest = null;
    streamTarget = null;
    set((s) => ({ running: false, status: null, items: s.items.map((i) => (i.role === 'assistant' && i.streaming ? { ...i, streaming: false } : i)) }));
  }
}

export function stopAssistant() {
  stopped = true;
  if (currentRequest) void api.aiCancel(currentRequest).catch(() => undefined);
  for (const [id, resolve] of approvals) {
    patchItem(id, { status: 'declined' } as Partial<ChatItem>);
    resolve(false);
  }
  approvals.clear();
}

/** Stop any run and wait until it has wound down. */
async function whenIdle() {
  if (!get().running) return;
  stopAssistant();
  await new Promise<void>((resolve) => {
    const off = useAssistant.subscribe((s) => {
      if (!s.running) {
        off();
        resolve();
      }
    });
  });
}

const emptyChat = () => ({ chatId: newChatId(), items: [], messages: [], noTools: false, status: null });

export async function newChat() {
  await whenIdle();
  flushSave();
  set(emptyChat());
}

export async function openChat(id: string) {
  if (id === get().chatId) return;
  await whenIdle();
  flushSave();
  set({ chatId: id, ...readChat(id), noTools: false, status: null });
}

export async function deleteChat(id: string) {
  if (id === get().chatId) await whenIdle();
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  forget(id);
  const chats = get().chats.filter((c) => c.id !== id);
  writeIndex(chats);
  set({ chats, ...(id === get().chatId ? emptyChat() : {}) });
}

// ---- checkpoints ----

const projectKey = (p: ProjectSnapshot) => p.sourcePath || p.name;

function checkpointNow(): Checkpoint | null {
  const project = appState().project;
  if (!project) return null;
  const top = [...project.history].reverse().find((h) => h.done);
  return { project: projectKey(project), id: top?.id ?? null, atMs: top?.atMs ?? null };
}

/**
 * Theme changes made since a prompt was sent, or null when the theme can no
 * longer go back there (another theme is open, or that step is gone).
 */
export function changesSince(item: Extract<ChatItem, { role: 'user' }>, project: ProjectSnapshot | null = appState().project): string[] | null {
  const cp = item.checkpoint;
  if (!project || !cp || cp.project !== projectKey(project)) return null;
  const history = project.history;
  let from: number;
  if (cp.id === null) {
    // "As opened" only means this session if every step came after the prompt.
    if (history.some((h) => h.atMs < (item.at ?? 0) - 1000)) return null;
    from = 0;
  } else {
    const at = history.findIndex((h) => h.id === cp.id && h.atMs === cp.atMs);
    if (at < 0) return null;
    from = at + 1;
  }
  return history.slice(from).filter((h) => h.done).map((h) => h.label);
}

/**
 * Rewind to just before a prompt: undo the theme changes made since, drop the
 * prompt and everything after it, and put its text back in the message box.
 */
export async function rewindTo(itemId: string) {
  const index = get().items.findIndex((i) => i.id === itemId);
  const item = get().items[index];
  if (!item || item.role !== 'user') return;
  await whenIdle();
  const changes = changesSince(item);
  const count = changes?.length ?? 0;
  const ok = await confirmDialog({
    title: 'Rewind to this message?',
    message: [
      count
        ? `${count} change${count === 1 ? '' : 's'} made to the theme since you sent it will be undone. You can redo them from History.`
        : changes
          ? 'The theme has not changed since you sent it.'
          : item.checkpoint
            ? 'The theme cannot go back to this point (another theme is open, or that history is gone), so only the chat rewinds.'
            : 'No theme checkpoint was saved with this message, so only the chat rewinds.',
      'This message and everything after it leave the chat, and the message goes back into the box to change and send again.',
    ].join(' '),
    detail: count ? changes!.slice(-10).reverse() : undefined,
    confirmLabel: count ? 'Undo changes and rewind' : 'Rewind chat',
    danger: count > 0,
  });
  if (!ok) return;
  if (count && item.checkpoint && !(await historyGoto(item.checkpoint.id))) return;
  set((s) => ({
    items: s.items.slice(0, index),
    messages: s.messages.slice(0, item.msgIndex ?? s.messages.length),
    draft: item.text,
  }));
}

/** Ask about something from elsewhere in the app ("Explain this file"). */
export function askAssistant(text: string) {
  const state = appState();
  if (state.section !== 'assistant') updateLayout({ assistant: true });
  sendMessage(text);
}
