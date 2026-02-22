# Claudia — Project Context for AI Assistants

## What is Claudia?

Claudia is a **macOS desktop application** built with Electron that provides a visual UI layer on top of **Claude Code** (Anthropic's CLI coding agent). It launches Claude Code sessions directly from within the app, names them, tracks their cost/token data, and exposes controls for resuming, rolling back, and reviewing code changes.

Sessions are **app-owned**: only sessions started from within Claudia appear in the UI. The integrated terminal panel opens alongside the session and stays accessible as a persistent, toggleable panel throughout the session lifecycle.

---

## Module Context Files

Detailed per-module documentation lives in `docs/`. Read these instead of this file for implementation details:

| File | Covers |
|---|---|
| [`docs/context-services.md`](docs/context-services.md) | Database, SessionParser, FileWatcher, HooksServer, TerminalService |
| [`docs/context-main-process.md`](docs/context-main-process.md) | Entry point, IPC handlers, claudeHooks setup |
| [`docs/context-ipc.md`](docs/context-ipc.md) | Preload bridge, full `window.api` surface, all IPC event channels |
| [`docs/context-renderer.md`](docs/context-renderer.md) | Zustand store, messageGrouper, all React components |
| [`docs/context-types.md`](docs/context-types.md) | All shared TypeScript interfaces |
| [`docs/claude-code-session-format.md`](docs/claude-code-session-format.md) | Claude Code JSONL transcript format reference |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 29 |
| Frontend | React 18 + TypeScript |
| Build tool | electron-vite (Vite-based) |
| Styling | TailwindCSS 3 + custom theme tokens |
| State management | Zustand |
| Database | better-sqlite3 v11+ (SQLite) |
| Terminal emulation | node-pty + @xterm/xterm + @xterm/addon-fit |
| File watching | chokidar |
| Markdown rendering | react-markdown + remark-gfm + react-syntax-highlighter |
| Icons | lucide-react |
| Date formatting | date-fns |
| Binary detection | which |

---

## Electron Process Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Main Process (Node.js — full OS access)  src/main/     │
│   index.ts · services/ · ipc/handlers.ts · setup/       │
└──────────────────────┬──────────────────────────────────┘
                       │  IPC (ipcMain / ipcRenderer)
┌──────────────────────▼──────────────────────────────────┐
│  Preload  src/preload/index.ts                          │
│  Exposes window.api via contextBridge                   │
└──────────────────────┬──────────────────────────────────┘
                       │  window.api.*
┌──────────────────────▼──────────────────────────────────┐
│  Renderer (React browser sandbox)  src/renderer/src/    │
│   App.tsx · stores/ · utils/ · components/              │
└─────────────────────────────────────────────────────────┘
```

**Key rule**: The renderer has zero Node.js access. All I/O goes through `window.api.*` → IPC → main.  
See [`docs/context-ipc.md`](docs/context-ipc.md) for the full API surface and event channels.

---

## Data Flow: New Session Launch

```
1. User fills NewSessionDialog (repo, branch, name)
   → window.api.sessions.launchNew({ projectPath, branch, name })
   → ipc/handlers.ts: git checkout branch
   → createTerminal('launch-<ts>', projectPath)  [placeholder terminal ID]
   → write 'claude\r' after 600ms
   → registerPendingLaunch(projectPath, launchId, name)
   → renderer: terminalSessionId = launchId, terminalVisible = true

2. Claude starts → writes first JSONL line
   → FileWatcher.ts (chokidar) detects new .jsonl
   → peekPendingLaunch(projectPath) → gets name
   → SessionParser.ts parses → ClaudeMessage[]
   → Database.ts upserts session { title: name, source: 'app' }
   → win.webContents.send('event:newSession')
   → useSessionStore.addSession() → session appears in sidebar

3. SessionStart hook fires
   → HTTP POST → HooksServer.ts :27182
   → tryNotifyStart retry loop finds session in DB
   → consumePendingLaunch(projectPath) → launchId
   → renameTerminal(launchId, realSessionId)
   → win.webContents.send('event:terminalLinked', { launchId, sessionId })
   → win.webContents.send('event:sessionStarted', session)
   → renderer: linkTerminal(launchId→realSessionId), selectSession(realSessionId)

4. Session ends (Stop hook)
   → markSessionCompleted() → refreshSession()
   → win.webContents.send('event:sessionUpdated')
```

## Data Flow: Resume Existing Session

```
User clicks Resume in SessionControls
  → resumeSession(sessionId, projectPath)
  → createTerminal(sessionId, projectPath)
  → write 'claude --resume <sessionId>\r' after 500ms
  → terminalVisible = true
```

---

## Main Process Modules (`src/main/`)

> Full details: [`docs/context-main-process.md`](docs/context-main-process.md) · [`docs/context-services.md`](docs/context-services.md)

| File | Responsibility |
|---|---|
| `index.ts` | Window creation, startup sequence (IPC → HooksServer → FileWatcher), before-quit cleanup |
| `services/Database.ts` | SQLite (`claudia.db`): `sessionDb`, `messageDb`, `projectDb`, `settingsDb` namespaces |
| `services/SessionParser.ts` | Parses JSONL transcripts → `ClaudeMessage[]`; `scanClaudeProjects()`, `decodeProjectPath()` |
| `services/FileWatcher.ts` | chokidar watcher (no startup import); `pendingLaunches` map; tracks `lastLineCount` per file |
| `services/HooksServer.ts` | HTTP server on `:27182`; handles `SessionStart` (with retry), `Stop`, `Notification` hooks |
| `services/TerminalService.ts` | node-pty management (lazy-loaded); git CLI helpers (`getLastCommitDiff`, `stashChanges`, etc.) |
| `ipc/handlers.ts` | All `ipcMain.handle()` registrations; `claude:launch` subprocess; `git:reviewWithClaude` one-shot |
| `setup/claudeHooks.ts` | Writes `~/.claude/claudia-bridge.sh` + installs it in `~/.claude/settings.json` |

---

## Preload & IPC

> Full details: [`docs/context-ipc.md`](docs/context-ipc.md)

`src/preload/index.ts` exposes `window.api` via `contextBridge`:

```
window.api.sessions.*  · projects.*  · settings.*  · hooks.*
         .claude.*     · terminal.*  · git.*
         .on(channel, cb) → unsubscribeFn
         .off(channel)
```

**Push events** (main → renderer via `window.api.on`):
`event:newSession` · `event:sessionUpdated` · `event:sessionStarted` · `event:terminalLinked` · `event:messageAdded` · `event:notification` · `event:claudeStreamEvent` · `event:claudeStreamError` · `event:claudeProcessExit` · `event:terminal:data` · `event:terminal:exit`

---

## Shared Types (`src/shared/types.ts`)

> Full details: [`docs/context-types.md`](docs/context-types.md)

Key interfaces: `Session` · `ClaudeMessage` · `ClaudeContent` (union) · `TranscriptEntry` · `SessionCostSummary` · `AppSettings` (+ `DEFAULT_SETTINGS`) · `Project` · `IpcChannels`

---

## Renderer — State & Components

> Full details: [`docs/context-renderer.md`](docs/context-renderer.md)

**Zustand store** (`useSessionStore`):
```typescript
sessions · projects · selectedSessionId · messages (lazy, keyed by sessionId)
settings · isLoading · sidebarView
terminalSessionId    // current PTY key (starts as launchId, updated to realSessionId)
terminalVisible      // controls GlobalTerminalPanel visibility
```
- `openTerminalForSession(id, path)` — creates PTY, sets `terminalVisible: true`
- `resumeSession(id, path)` — creates PTY + writes `claude --resume <id>\r`, sets `terminalVisible: true`
- `toggleTerminalVisible()` — show/hide the terminal panel
- `linkTerminal(launchId, sessionId)` — swaps placeholder ID for real session ID on `event:terminalLinked`

**`utils/messageGrouper.ts`** — converts flat `ClaudeMessage[]` → `ConversationTurn[]` (groups consecutive assistant + tool_result_user entries; merges thinking/tools/text blocks).

**Component tree** (overview):
```
App.tsx
 ├── Sidebar.tsx (sessions/projects toggle, search, SessionItem, SettingsPanel modal)
 └── MainPanel.tsx
      ├── [left, 55% when terminal open OR full width] content area
      │    ├── [no session] WelcomeScreen + NewSessionDialog modal
      │    └── [session selected] SessionView
      │         ├── ChatHeader (+ terminal toggle button)
      │         ├── SessionControls (active only: Resume + Rollback)
      │         └── Tabs: Code* | Logs | Session Info | Consumption
      └── [right, 45%] GlobalTerminalPanel (shown when terminalVisible=true)
           └── TerminalPane (xterm.js)
```
`*` = active sessions only

**Key components**:
- `AssistantTurnBubble` — renders grouped thinking/tool/text blocks with `react-markdown` + syntax highlighting
- `MessageBubble` — user messages only (text blocks, right-aligned)
- `SessionControls` — Rollback (`git stash`) + Resume (opens/resumes terminal)
- `ChatHeader` — session title, status, model badge + **terminal toggle button**
- `GlobalTerminalPanel` — persistent right-side panel driven by `terminalVisible`; persists across session switches
- `NewSessionDialog` — repo picker + branch selector + **session name field** (slug); calls `sessions.launchNew` directly
- `CodeTab` — per-file diff review with Accept/Reject/AI-review + general review dropdown
- `TerminalPane` — xterm.js with FitAddon + ResizeObserver

**Legacy/unused**: `ChatView.tsx`, `ThinkingBlock.tsx`, `ToolUseBlock.tsx` exist in repo but are not imported by the active component tree.

---

## TailwindCSS Custom Theme (`tailwind.config.js`)

```
claude-dark: #1A1A1A  claude-sidebar: #111111  claude-panel: #1C1C1E
claude-border: #2C2C2E  claude-hover: #2C2C2E
claude-text: #F5F5F5  claude-muted: #8E8E93  claude-orange: #D97757
```

---

## Build & Dev Setup

```bash
# Install (skips postinstall scripts to avoid native rebuild before Electron is set up)
npm install --ignore-scripts

# Rebuild native modules against Electron's Node headers
./node_modules/.bin/electron-rebuild -f -w better-sqlite3,node-pty

# Install Electron binary
node node_modules/electron/install.js

# Dev server (hot reload)
npm run dev

# Production build
npm run build

# Package for macOS
npm run package:mac
```

The postinstall script (`electron-rebuild -f -w better-sqlite3,node-pty`) runs automatically on normal `npm install`. It's skipped only when you need to avoid it during CI or first-time setup.

**Vite config** (`electron.vite.config.ts`): three separate Vite builds — main, preload, renderer. The renderer uses `@vitejs/plugin-react`.

**TypeScript**: three tsconfig files — `tsconfig.json` (root), `tsconfig.node.json` (main/preload), `tsconfig.web.json` (renderer).

---

## Key Design Decisions

1. **App-owned sessions**: Only sessions launched from within Claudia are shown. `sessions:list` filters `WHERE source = 'app'`. This prevents external Claude Code runs from polluting the UI and enables reliable terminal↔session linking.

2. **Pending launch mechanism**: When the user launches a session, a `launchId` (placeholder) is registered in `pendingLaunches` map. FileWatcher peeks it for the user-provided name; HooksServer consumes it to rename the terminal PTY from placeholder → real session ID. This solves the race where the real session ID doesn't exist until Claude starts.

3. **`event:terminalLinked`** bridges the launch and session: renderer receives `{ launchId, sessionId }` and swaps the terminal's key in the store. This lets the terminal pane render correctly before the real session ID is known.

4. **Terminal is a persistent global panel**: `GlobalTerminalPanel` renders at the `MainPanel` level (not inside `SessionView`), driven by `terminalVisible`. It persists as the user switches between session tabs or even between sessions. Toggle button lives in `ChatHeader`.

5. **Resume writes the command**: `claude --resume <id>` is typed into the terminal (not passed as CLI args) to give the user a visible, interactive session they can take over. A 500ms delay gives the shell time to settle.

6. **`cwd` from first JSONL entry is the source of truth** for project path. The encoded folder name (`-Users-gabriel-my-project`) is only a fallback because it breaks on paths with hyphens.

7. **Code tab is active-sessions-only**: Showing git diffs only makes sense when Claude is actively making changes. The tab is disabled (greyed out, `cursor-not-allowed`) for completed sessions.

8. **`reviewWithClaude` is one-shot**: The AI review feature runs `claude --resume <id> -p <prompt> --output-format json` synchronously. It resumes the existing session context so Claude has full awareness of what it did.

9. **Messages are stored denormalized**: `content` in the `messages` table is a JSON string of `ClaudeContent[]`. This avoids schema migration complexity as Claude's content format evolves.

10. **SQLite WAL mode**: Allows concurrent reads while writing, important because the file watcher and IPC handlers can both access the database simultaneously.

11. **Import feature (Phase 2 — not yet built)**: `scanClaudeProjects()` and `importExistingSessions()` in `FileWatcher.ts`/`SessionParser.ts` are preserved but not called at startup. Future "Import Session" button will use them to bring external sessions in with a user-provided name.

---

## Common Pitfalls for Contributors

- **Never access Node APIs directly from the renderer** — always go through `window.api.*`
- **`node-pty` and `better-sqlite3` are native modules** — they must be rebuilt after `npm install` with `electron-rebuild`. If the app crashes on start, this is almost always the cause.
- **`better-sqlite3` requires v11+** — v9 fails against Node 24 C++ headers used by Electron 29
- **The `messages` map in the store is keyed by `sessionId`** — the lazy-load guard (`if (existing) return`) means messages won't refresh if you re-select a session. Force a refresh by deleting the cache entry first.
- **Session status** is only set to `active` when a `SessionStart` hook fires. Without hooks installed, all sessions appear as `completed` even if Claude is currently running.
- **`decodeProjectPath`** does filesystem I/O (greedy `fs.existsSync` walk) — it's only called at scan time, not on hot paths.
- **The `which` package** is used to find the `claude` binary in PATH when no explicit path is configured in settings.
