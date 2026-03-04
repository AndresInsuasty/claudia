import http from 'http'
import { basename } from 'path'
import { sessionDb } from './Database'
import { markSessionCompleted, refreshSession, consumePendingLaunch, consumeAnyPendingLaunch } from './FileWatcher'
import { renameTerminal } from './TerminalService'
import { sendToRenderer } from './WindowManager'

let server: http.Server | null = null

export function startHooksServer(port: number = 27182): void {
  if (server) return

  server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }

    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        const event = JSON.parse(body)
        handleHookEvent(event)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[HooksServer] Listening on http://127.0.0.1:${port}`)
  })

  server.on('error', err => {
    console.error('[HooksServer] Error:', err)
  })
}

export function stopHooksServer(): void {
  if (server) {
    server.close()
    server = null
  }
}

export function isHooksServerRunning(): boolean {
  return server !== null
}

function handleHookEvent(event: Record<string, unknown>): void {
  const hookEvent = event.hook_event_name as string
  const sessionId = event.session_id as string

  console.log(`[HooksServer] Hook event: ${hookEvent} session: ${sessionId}`)

  switch (hookEvent) {
    case 'SessionStart': {
      if (sessionId) {
        // Claude Code sends cwd in the hook payload — use it to find the pending launch
        // without waiting for the JSONL file (which may not exist yet at session start).
        const cwd = event.cwd as string | undefined
        console.log(
          `[HooksServer] SessionStart session=${sessionId} cwd=${cwd} payload_keys=${Object.keys(event).join(',')}`
        )

        // Try matching by cwd first; fall back to consuming any pending launch
        // (covers cases where Claude Code doesn't include cwd in the hook payload)
        let pending = cwd ? consumePendingLaunch(cwd) : undefined
        let resolvedCwd = cwd

        if (!pending) {
          // Fallback: consume the first pending launch regardless of path
          const any = consumeAnyPendingLaunch()
          if (any) {
            pending = any.launch
            resolvedCwd = resolvedCwd || any.projectPath
            console.log(`[HooksServer] Fallback match: pending launch ${pending.launchId} from path=${any.projectPath}`)
          }
        }

        if (pending) {
          // App-launched session: create the real session in DB immediately from hook data
          console.log(`[HooksServer] Matched pending launch ${pending.launchId} → ${sessionId}`)
          const projectName = resolvedCwd ? basename(resolvedCwd) : sessionId
          const realSession = {
            id: sessionId,
            projectPath: resolvedCwd ?? '',
            projectName,
            transcriptPath: '',
            startedAt: new Date().toISOString(),
            model: 'claude-opus-4-5',
            status: 'active' as const,
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            messageCount: 0,
            title: pending.name,
            tags: [],
            branch: pending.branch,
            source: 'app' as const
          }
          sessionDb.upsert(realSession)

          // Remove provisional session
          sessionDb.delete(pending.launchId)
          console.log(`[HooksServer] Deleted provisional session id=${pending.launchId}`)

          // Rename PTY so terminal stays connected
          renameTerminal(pending.launchId, sessionId)
          console.log(`[HooksServer] Renamed terminal ${pending.launchId} → ${sessionId}`)

          // Notify renderer: swap provisional → real, link terminal, select session
          sendToRenderer('event:sessionReplaced', {
            launchId: pending.launchId,
            sessionId,
            session: realSession
          })
          sendToRenderer('event:terminalLinked', { launchId: pending.launchId, sessionId })
          sendToRenderer('event:sessionStarted', realSession)
        } else {
          // Session not launched from app (or cwd missing) — check if already in DB
          console.warn(`[HooksServer] No pending launch for cwd=${cwd} — session ${sessionId} may be external`)
          const existing = sessionDb.getById(sessionId)
          if (existing) {
            sessionDb.updateStatus(sessionId, 'active')
            const updated = sessionDb.getById(sessionId)
            if (updated) sendToRenderer('event:sessionStarted', updated)
          }
        }
      }
      break
    }

    case 'Stop': {
      if (sessionId) {
        sendToRenderer('event:sessionActivity', {
          sessionId,
          type: 'stopped',
          timestamp: new Date().toISOString()
        })
        // Delay to allow Claude Code to flush JSONL before we read it
        setTimeout(() => {
          refreshSession(sessionId).then(() => {
            const session = sessionDb.getById(sessionId)
            if (session) {
              sendToRenderer('event:sessionUpdated', session)
            }
          })
        }, 800)
      }
      break
    }

    case 'SessionEnd': {
      if (sessionId) {
        markSessionCompleted(sessionId)
        sendToRenderer('event:sessionActivity', {
          sessionId,
          type: 'session_ended',
          timestamp: new Date().toISOString()
        })
        setTimeout(() => {
          refreshSession(sessionId).then(() => {
            const session = sessionDb.getById(sessionId)
            if (session) {
              sendToRenderer('event:sessionUpdated', session)
            }
          })
        }, 800)
      }
      break
    }

    case 'PostToolUse': {
      if (sessionId) {
        const toolName = event.tool_name as string | undefined
        console.log(`[HooksServer] PostToolUse session=${sessionId} tool=${toolName}`)
        sendToRenderer('event:sessionActivity', {
          sessionId,
          type: 'tool_completed',
          detail: toolName,
          timestamp: new Date().toISOString()
        })
        refreshSession(sessionId).then(() => {
          const session = sessionDb.getById(sessionId)
          if (session) {
            sendToRenderer('event:sessionUpdated', session)
          }
        })
      }
      break
    }

    case 'UserPromptSubmit': {
      if (sessionId) {
        console.log(`[HooksServer] UserPromptSubmit session=${sessionId}`)
        sendToRenderer('event:sessionActivity', {
          sessionId,
          type: 'user_prompt',
          timestamp: new Date().toISOString()
        })
        // Delay to allow Claude Code to write the user message to JSONL
        setTimeout(() => {
          refreshSession(sessionId).then(() => {
            const session = sessionDb.getById(sessionId)
            if (session) {
              sendToRenderer('event:sessionUpdated', session)
            }
          })
        }, 800)
      }
      break
    }

    case 'Notification': {
      const message = event.message as string
      sendToRenderer('event:notification', { sessionId, message })
      // Notification fires when Claude shows interactive questions (AskUserQuestion).
      // Refresh the session so the question appears in the logs.
      if (sessionId) {
        sendToRenderer('event:sessionActivity', {
          sessionId,
          type: 'notification',
          detail: message,
          timestamp: new Date().toISOString()
        })
        setTimeout(() => {
          refreshSession(sessionId).then(() => {
            const session = sessionDb.getById(sessionId)
            if (session) {
              sendToRenderer('event:sessionUpdated', session)
            }
          })
        }, 800)
      }
      break
    }

    default:
      break
  }
}
