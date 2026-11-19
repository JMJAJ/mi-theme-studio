# Architecture

Mi Theme Studio is a Tauri v2 application. The Rust backend owns all package data, file system access, process execution (ADB) and network requests; the React UI renders state and sends commands.

## Data flow

```
React UI ──invoke──▶ commands.rs ──▶ project / package / validation / storage / adb / store
   ▲                      │
   │  ProjectSnapshot     │  (file list + metadata, never file contents)
   └──────────────────────┘
<img src="themeres://localhost/main/<path>?v=<rev>">  ──▶ protocol.rs (bytes straight from memory)
```

- **Project model** (`project/mod.rs`): a flat `BTreeMap<path, Arc<Blob>>`. Files inside component archives use `outer!/inner` keys. Blobs are immutable, so "unchanged since import" and undo/redo are pointer comparisons.
- **Transactions**: every edit runs through `Project::transact`, which records the first *before* and last *after* blob for each touched path, rolls back on error, and pushes one undoable `Change`.
- **Snapshots** (`project/snapshot.rs`): after each command the UI receives a snapshot with every file's size, kind, component, format, dimensions, density, status (`original` / `modified` / `added`) and revision. Image previews load through the `themeres:` URI scheme, cache-busted by revision.
- **Export**: `Project::export_entries` writes untouched component archives from their original bytes and rebuilds changed ones with their original child order and per-entry compression. `commands::project_save` writes atomically, verifies against the expected entries, backs up the previous file and updates the saved marker.

## Frontend

- `state/store.ts` — zustand store: snapshots, tabs, selection, drafts, layout, logs, device state, dialogs. Selectors must return stable references.
- `state/actions.ts` — every user operation; handles errors, toasts, logging and snapshot updates.
- `state/commands.ts` — command registry used by the menu bar, the command palette and keyboard shortcuts.
- Layout: top bar + menus, navigator + explorer (left), tabbed workspace (center), inspector (right), dock (bottom), status bar. Panels are resizable with keyboard-accessible splitters; sizes persist in `localStorage`.
- Text edits are kept as drafts until applied (Ctrl+Enter, Apply, or Save), so CodeMirror's own undo works inside the editor while package-level undo covers applied changes.

## AI assistant

- `src-tauri/src/ai.rs` is one OpenAI-compatible chat client for every provider (local AIProxy/CLIProxyAPI pool, Pollinations, NVIDIA NIM, OpenRouter, Gemini, Groq, Ollama, custom). Provider settings live in `ai.json` in the config folder; API keys stay in the backend and the UI only sees `hasKey`. `ai_chat` streams `ai-stream` events and returns the assembled reply (text, reasoning, tool calls); `ai_cancel` stops it.
- The agent loop runs in the UI (`state/assistant.ts`): it sends the conversation plus tool definitions, runs the tools the model calls (`state/assistantTools.ts`: list/read/search files, edit/write/delete files, theme details, validation, the MAML guide), and repeats. Every change goes through the normal commands, so it is one undoable step; changes are shown as a diff for approval unless auto-apply is on.
- UI: a side panel next to any section (Ctrl+Shift+A) or the full-screen Assistant section (Ctrl+8); setup is in Settings → AI assistant.

## Safety rules

- Archive paths are sanitized on import (`package/paths.rs`); user-entered names are validated against Windows-unsafe characters.
- Import limits: 100 000 entries, 512 MB per entry, 2 GB expanded total; declared sizes are not trusted.
- Device commands only run via `adb/runner.rs` with timeouts, cancellation and `CREATE_NO_WINDOW`; device-side shell arguments are fixed or restricted to `[A-Za-z0-9._+-]`. The Theme Manager cache browser reads bounded metadata and image files from fixed paths and validates IDs and preview names before constructing remote paths. The experimental AOD permanent apply (see `docs/device-integration.md`) uses fixed remote directories and generated MAML; it rejects unsafe top-level package names before building paths.
- The store client builds every URL from fixed routes and validated IDs; image URLs are limited to `https://*.mi-img.com` (also enforced by the CSP), downloads to HTTPS Xiaomi hosts, and packages are SHA-1 verified. Paid themes are never downloaded.

## Tests

- Rust: `cargo test` in `src-tauri` covers path sanitizing, hostile archives, limits, nested components, round-trip byte preservation, metadata rewriting, undo/redo/goto, rename/move/duplicate/pack, reference copy, validation, storage, ADB output parsing, process timeout/cancellation, and store parsing/downloads.
- Frontend: `npm test` covers path/tree helpers, formatting, shortcut matching and the command registry.
