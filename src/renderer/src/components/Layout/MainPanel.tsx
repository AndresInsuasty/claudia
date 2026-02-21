import React, { useState, useCallback } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import WelcomeScreen from './WelcomeScreen'
import LogsTab from '../Chat/LogsTab'
import SessionInfoTab from '../SessionInfo/SessionInfoTab'
import ConsumptionTab from '../Consumption/ConsumptionTab'
import CodeTab from '../Code/CodeTab'
import TerminalPane from '../Terminal/TerminalPane'
import SessionControls from '../Terminal/SessionControls'
import ChatHeader from '../Chat/ChatHeader'
import NewSessionDialog from './NewSessionDialog'
import { Code2, ScrollText, Info, Zap, Plus } from 'lucide-react'
import type { Session } from '../../../../shared/types'

type TabId = 'logs' | 'code' | 'session' | 'consumption'

interface TabDef {
  id: TabId
  label: string
  icon: React.ReactNode
  activeOnly?: boolean
}

const TABS: TabDef[] = [
  { id: 'code',        label: 'Code',         icon: <Code2 size={13} />,       activeOnly: true },
  { id: 'logs',        label: 'Logs',          icon: <ScrollText size={13} /> },
  { id: 'session',     label: 'Session Info',  icon: <Info size={13} /> },
  { id: 'consumption', label: 'Consumption',   icon: <Zap size={13} /> },
]

function SessionView({ session }: { session: Session }): React.JSX.Element {
  const isActive = session.status === 'active'
  const [activeTab, setActiveTab] = useState<TabId>('logs')
  const [showNewSession, setShowNewSession] = useState(false)
  const { terminalSessionId, openTerminalForSession, closeTerminal } = useSessionStore()

  const terminalOpen = terminalSessionId === session.id
  const currentTab = isActive ? activeTab : (activeTab === 'code' ? 'logs' : activeTab)

  const handleResume = useCallback(async () => {
    await openTerminalForSession(session.id, session.projectPath)
  }, [session.id, session.projectPath, openTerminalForSession])

  const handleRollback = useCallback(async () => {
    await window.api.git.stash(session.projectPath)
  }, [session.projectPath])

  const handleCloseTerminal = useCallback(async () => {
    await closeTerminal()
  }, [closeTerminal])

  const handleLaunchNew = async (projectPath: string, _branch: string) => {
    const result = await window.api.terminal.create(`new-${Date.now()}`, projectPath)
    if (result.success) {
      setTerminalOpen(true)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Session header */}
      <ChatHeader session={session} />

      {/* Active session controls */}
      {isActive && (
        <SessionControls
          session={session}
          terminalOpen={terminalOpen}
          onResume={handleResume}
          onRollback={handleRollback}
          onClose={handleCloseTerminal}
        />
      )}

      {/* Tab bar */}
      <div className="flex items-center border-b border-claude-border bg-claude-panel shrink-0 px-2">
        {TABS.map(tab => {
          const disabled = tab.activeOnly && !isActive
          const isCurrent = currentTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => !disabled && setActiveTab(tab.id)}
              disabled={disabled}
              title={disabled ? 'Only available for active sessions' : undefined}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs border-b-2 transition-colors ${
                isCurrent
                  ? 'border-claude-orange text-claude-text'
                  : disabled
                  ? 'border-transparent text-claude-muted/40 cursor-not-allowed'
                  : 'border-transparent text-claude-muted hover:text-claude-text'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}
        <div className="ml-auto flex items-center pr-1">
          <button
            onClick={() => setShowNewSession(true)}
            className="p-1.5 rounded hover:bg-claude-hover text-claude-muted hover:text-claude-text transition-colors"
            title="New session"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Main content area — tabs left, terminal right */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tab content */}
        <div className={`flex flex-col overflow-hidden ${terminalOpen ? 'w-[55%]' : 'flex-1'}`}>
          {currentTab === 'logs'        && <LogsTab session={session} />}
          {currentTab === 'session'     && <SessionInfoTab session={session} />}
          {currentTab === 'consumption' && <ConsumptionTab session={session} />}
          {currentTab === 'code'        && isActive && <CodeTab session={session} />}
        </div>

        {/* Terminal pane — right side, shows for active sessions automatically */}
        {terminalOpen && (
          <div className="w-[45%] min-w-[320px] border-l border-claude-border flex flex-col">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-claude-panel border-b border-claude-border shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-claude-muted">{'>'}_</span>
                <span className="text-xs text-claude-text font-medium">Terminal</span>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" title="Connected" />
              </div>
              <button
                onClick={handleCloseTerminal}
                className="text-claude-muted hover:text-claude-text text-xs px-2 py-0.5 rounded hover:bg-claude-hover transition-colors"
                title="Close terminal"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <TerminalPane sessionId={session.id} />
            </div>
          </div>
        )}
      </div>

      {showNewSession && (
        <NewSessionDialog onClose={() => setShowNewSession(false)} onLaunch={handleLaunchNew} />
      )}
    </div>
  )
}

export default function MainPanel(): React.JSX.Element {
  const { selectedSessionId, sessions } = useSessionStore()
  const [showNewSession, setShowNewSession] = useState(false)
  const session = sessions.find(s => s.id === selectedSessionId)

  if (!selectedSessionId || !session) {
    return (
      <>
        <WelcomeScreen onNewSession={() => setShowNewSession(true)} />
        {showNewSession && (
          <NewSessionDialog
            onClose={() => setShowNewSession(false)}
            onLaunch={async (projectPath) => {
              await window.api.terminal.create(`new-${Date.now()}`, projectPath)
              setShowNewSession(false)
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <SessionView session={session} />
    </div>
  )
}
