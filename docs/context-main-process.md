# Main Process Entry & IPC — Context

Files: `src/main/index.ts`, `src/main/ipc/handlers.ts`, `src/main/setup/claudeHooks.ts`

---

## `index.ts` — Entry Point

### Window creation (`createWindow`)
- `BrowserWindow`: 1280×800 (min 900×600), `titleBarStyle: 'hiddenInset'`, `vibrancy: 'sidebar'`, `backgroundColor: '#111111'`
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`
- Opens Vite dev URL in dev mode; loads `renderer/index.html` in prod
- Forces `nativeTheme.themeSource = 'dark'`

### Startup sequence (`app.whenReady`)
1. `registerIpcHandlers(win)` — binds all `ipcMain.handle()` calls
2. `settingsDb.get()` — reads persisted settings
3. If `settings.hooksEnabled`: starts `HooksServer` on `settings.hooksServerPort` and calls `installHooks()`
4. `startFileWatcher(win)` — always runs (passive session watching is primary)

### Cleanup (`before-quit`)
`cleanupProcesses()` → `killAllTerminals()` → `stopFileWatcher()` → `stopHooksServer()` → `closeDb()`

---

## `ipc/handlers.ts` — IPC Contract

All `ipcMain.handle()` registrations. This is the single surface between renderer and main process.

### Session handlers
| Channel | Action |
|---|---|
| `sessions:list` | `sessionDb.list()` — filters `WHERE source = 'app'` |
| `sessions:get` | `sessionDb.getById(id)` |
| `sessions:getMessages` | `messageDb.getBySessionId(id)` |
| `sessions:getCostSummary` | reads from `sessionDb.getById()`, returns `SessionCostSummary` shape (cache tokens are 0 — stored as 0 in DB currently) |
| `sessions:delete` | `sessionDb.delete(id)` |
| `sessions:updateTitle` | `sessionDb.updateTitle(id, title)` |
| `sessions:addTag` | reads tags, deduplicates, calls `sessionDb.updateTags()` |
| `sessions:removeTag` | filters and calls `sessionDb.updateTags()` |
| `sessions:launchNew` | `git checkout branch` → `createTerminal(launchId, cwd)` → write `claude\r` after 600ms → `registerPendingLaunch(path, launchId, name)` → returns `{ success, launchId }` |

### Other data handlers
| Channel | Action |
|---|---|
| `projects:list` | `projectDb.list()` |
| `settings:get` | `settingsDb.get()` |
| `settings:update` | `settingsDb.update(partial)` |
| `hooks:install` | `installHooks()` |
| `hooks:uninstall` | `uninstallHooks()` |
| `hooks:status` | `{ installed: areHooksInstalled(), serverRunning: isHooksServerRunning() }` |

### `claude:launch`
Spawns `claude --output-format stream-json --verbose [--resume <id>] [--allowedTools ...] [-p <prompt>]` as a child process.
- Resolves `claude` binary via `which` if not configured in settings
- Streams stdout JSON lines → `event:claudeStreamEvent` per line
- Streams stderr → `event:claudeStreamError`
- On exit → `event:claudeProcessExit`
- Returns `{ success: true, pid }` or `{ success: false, error }`
- Tracked in `runningProcesses: Map<pid, ChildProcess>`

### `claude:kill`
Sends `SIGTERM` to tracked PID, removes from `runningProcesses`.

### Terminal handlers
| Channel | Delegates to |
|---|---|
| `terminal:create` | `createTerminal(sessionId, cwd, win)` — also used by `resumeSession` flow |
| `terminal:write` | `writeTerminal(sessionId, data)` |
| `terminal:resize` | `resizeTerminal(sessionId, cols, rows)` |
| `terminal:kill` | `killTerminal(sessionId)` |
| `terminal:isRunning` | `isTerminalRunning(sessionId)` → boolean |

### Git handlers
| Channel | Delegates to |
|---|---|
| `git:lastCommitDiff` | `getLastCommitDiff(projectPath)` |
| `git:fileDiff` | `getFileDiff(projectPath, filePath)` |
| `git:revertFile` | `revertFile(projectPath, filePath)` |
| `git:stash` | `stashChanges(projectPath)` |
| `git:branches` | `getBranches(projectPath)` |
| `git:findRepos` | `findGitRepos(baseDir)` |

### `git:reviewWithClaude`
One-shot Claude invocation: `claude --resume <sessionId> -p <prompt> --output-format json`  
Run via `execAsync` with 120s timeout in `projectPath` dir. Returns `{ success, response }` or `{ success: false, error }`.

### `cleanupProcesses()` (exported)
Kills all tracked child processes on app quit.

---

## `setup/claudeHooks.ts` — Hook Installation

Writes into `~/.claude/settings.json` to install/uninstall the Claudia bridge.

### What it installs

**Script**: `~/.claude/claudia-bridge.sh`  
A bash script that reads stdin (the hook payload) and POSTs it to `http://127.0.0.1:27182`. Exits 0 always (non-blocking for Claude Code).

**Hook events registered** in `~/.claude/settings.json`:
- `SessionStart`, `Stop`, `SessionEnd`, `Notification`

Each event gets a hook entry of the form:
```json
{ "hooks": [{ "type": "command", "command": "/path/claudia-bridge.sh", "timeout": 5 }] }
```

### Exported functions

**`installHooks()`** → `{ success, error? }`  
Creates the script, reads settings, checks for existing `claudia-bridge` entries (idempotent), appends if not present, writes back.

**`uninstallHooks()`** → `{ success, error? }`  
Filters out all `claudia-bridge` entries from all hook events. Deletes `claudia-bridge.sh`. Cleans up empty event arrays.

**`areHooksInstalled()`** → `boolean`  
Checks `SessionStart` hooks for any entry containing `claudia-bridge`.
