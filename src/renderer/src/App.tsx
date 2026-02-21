import React, { useEffect } from 'react'
import { useSessionStore } from './stores/sessionStore'
import Sidebar from './components/Layout/Sidebar'
import MainPanel from './components/Layout/MainPanel'
import type { Session, ClaudeMessage } from '../../shared/types'

export default function App(): React.JSX.Element {
  const {
    loadSessions,
    loadProjects,
    loadSettings,
    addSession,
    updateSession,
    addMessage,
    openTerminalForSession,
    selectSession
  } = useSessionStore()

  useEffect(() => {
    loadSessions()
    loadProjects()
    loadSettings()

    const offNewSession = window.api.on('event:newSession', (session: unknown) => {
      addSession(session as Session)
    })

    const offSessionUpdated = window.api.on('event:sessionUpdated', (session: unknown) => {
      updateSession(session as Session)
    })

    const offSessionStarted = window.api.on('event:sessionStarted', (session: unknown) => {
      const sess = session as Session
      updateSession(sess)

      // Auto-open terminal for active sessions
      if (sess.status === 'active') {
        openTerminalForSession(sess.id, sess.projectPath)
        // Auto-select the session to show it in the UI
        selectSession(sess.id)
      }
    })

    const offMessageAdded = window.api.on(
      'event:messageAdded',
      (data: unknown) => {
        const { sessionId, message } = data as { sessionId: string; message: ClaudeMessage }
        addMessage(sessionId, message)
        loadSessions()
      }
    )

    return () => {
      offNewSession()
      offSessionUpdated()
      offSessionStarted()
      offMessageAdded()
    }
  }, [])

  return (
    <div className="flex h-full w-full overflow-hidden bg-claude-dark">
      <Sidebar />
      <MainPanel />
    </div>
  )
}
