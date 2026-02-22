# IPC Bridge & Event Channels — Context

File: `src/preload/index.ts`  
Type declarations: `src/renderer/src/types/global.d.ts`  
IPC channel types: `src/shared/types.ts` → `IpcChannels`

---

## Preload Bridge

`contextBridge.exposeInMainWorld('api', api)` makes the following object available as `window.api` in the renderer. The renderer has **zero direct Node.js access** — everything goes through this surface.

---

## `window.api` Full Surface

```typescript
window.api = {
  sessions: {
    list():                                  Promise<Session[]>   // only source='app'
    get(id):                                 Promise<Session | null>
    getMessages(id):                         Promise<ClaudeMessage[]>
    getCostSummary(id):                      Promise<SessionCostSummary | null>
    delete(id):                              Promise<void>
    updateTitle(id, title):                  Promise<void>
    addTag(id, tag):                         Promise<void>
    removeTag(id, tag):                      Promise<void>
    launchNew(opts: { projectPath, branch, name }):
                                             Promise<{ success: boolean; launchId?: string; error?: string }>
  },

  projects: {
    list():                                  Promise<Project[]>
  },

  settings: {
    get():                                   Promise<AppSettings>
    update(partial: Partial<AppSettings>):   Promise<void>
  },

  hooks: {
    install():                               Promise<{ success: boolean; error?: string }>
    uninstall():                             Promise<{ success: boolean; error?: string }>
    status():                                Promise<{ installed: boolean; serverRunning: boolean }>
  },

  claude: {
    launch(opts: { cwd, prompt?, sessionId?, resume? }):
                                             Promise<{ success: boolean; pid?: number; error?: string }>
    kill(pid):                               Promise<void>
  },

  terminal: {
    create(sessionId, cwd):                  Promise<{ success: boolean }>
    write(sessionId, data):                  Promise<void>
    resize(sessionId, cols, rows):           Promise<void>
    kill(sessionId):                         Promise<void>
    isRunning(sessionId):                    Promise<boolean>
  },

  git: {
    lastCommitDiff(projectPath):             Promise<{ files: [{path, additions, deletions}[]]; rawDiff: string }>
    fileDiff(projectPath, filePath):         Promise<string>
    revertFile(projectPath, filePath):       Promise<{ success: boolean; error?: string }>
    stash(projectPath):                      Promise<{ success: boolean; error?: string }>
    branches(projectPath):                   Promise<string[]>
    findRepos(baseDir):                      Promise<string[]>
    reviewWithClaude(opts: { sessionId, projectPath, prompt }):
                                             Promise<{ success: boolean; response?: string; error?: string }>
  },

  on(channel, callback):  () => void   // returns unsubscribe function
  off(channel):  void
}
```

---

## Main → Renderer IPC Events

Subscribed in the renderer via `window.api.on(channel, callback)`. The `on()` call returns an unsubscribe function — call it in the component's cleanup to avoid memory leaks.

| Event channel | Payload | Emitted by |
|---|---|---|
| `event:newSession` | `Session` | `FileWatcher` — new `.jsonl` file detected |
| `event:sessionUpdated` | `Session` | `FileWatcher` — file changed; `HooksServer` — Stop/SessionEnd |
| `event:sessionStarted` | `Session` | `HooksServer` — SessionStart hook (session now `active`) |
| `event:terminalLinked` | `{ launchId: string; sessionId: string }` | `HooksServer` — emitted on SessionStart after `renameTerminal`; tells renderer to swap placeholder ID for real session ID |
| `event:messageAdded` | `{ sessionId: string; message: ClaudeMessage }` | `FileWatcher` — new line in watched file |
| `event:notification` | `{ sessionId: string; message: string }` | `HooksServer` — Notification hook |
| `event:claudeStreamEvent` | `{ pid: number; event: object }` | `ipc/handlers.ts` — stdout JSON line from spawned claude process |
| `event:claudeStreamError` | `{ pid: number; error: string }` | `ipc/handlers.ts` — stderr from spawned claude process |
| `event:claudeProcessExit` | `{ pid: number; code: number \| null }` | `ipc/handlers.ts` — spawned claude process exited |
| `event:terminal:data` | `{ sessionId: string; data: string }` | `TerminalService` — PTY output chunk |
| `event:terminal:exit` | `{ sessionId: string }` | `TerminalService` — PTY process exited |

---

## Important Notes

- `window.api.on()` registers a listener on the channel and returns a **cleanup function** (calls `ipcRenderer.removeAllListeners(channel)`). Always call the cleanup in `useEffect` return.
- `window.api.off(channel)` removes ALL listeners for that channel — use with care if multiple components listen to the same channel.
- All `window.api.*` calls are `async` — they invoke `ipcRenderer.invoke()` under the hood, which returns a Promise.
- There is no request/response correlation for push events (main → renderer); events are broadcast to the single renderer window.
