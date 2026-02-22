import { create } from 'zustand'
import type { Session, ClaudeMessage, Project, AppSettings } from '../../../shared/types'

interface SessionStore {
  sessions: Session[]
  projects: Project[]
  selectedSessionId: string | null
  messages: Record<string, ClaudeMessage[]>
  settings: AppSettings | null
  isLoading: boolean
  sidebarView: 'sessions' | 'projects'
  terminalSessionId: string | null
  terminalVisible: boolean

  loadSessions: () => Promise<void>
  loadProjects: () => Promise<void>
  loadMessages: (sessionId: string) => Promise<void>
  loadSettings: () => Promise<void>
  selectSession: (sessionId: string | null) => void
  updateSession: (session: Session) => void
  addSession: (session: Session) => void
  addMessage: (sessionId: string, message: ClaudeMessage) => void
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>
  setSidebarView: (view: 'sessions' | 'projects') => void
  deleteSession: (id: string) => Promise<void>
  updateSessionTitle: (id: string, title: string) => Promise<void>
  openTerminalForSession: (sessionId: string, projectPath: string) => Promise<void>
  launchSessionTerminal: (launchId: string, projectPath: string) => Promise<void>
  resumeSession: (sessionId: string, projectPath: string) => Promise<void>
  closeTerminal: () => Promise<void>
  toggleTerminalVisible: () => void
  linkTerminal: (launchId: string, sessionId: string) => void
  replaceSession: (launchId: string, sessionId: string, session: Session) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  projects: [],
  selectedSessionId: null,
  messages: {},
  settings: null,
  isLoading: false,
  sidebarView: 'sessions',
  terminalSessionId: null,
  terminalVisible: false,

  loadSessions: async () => {
    set({ isLoading: true })
    try {
      const sessions = await window.api.sessions.list()
      set({ sessions, isLoading: false })
    } catch (err) {
      console.error('Failed to load sessions:', err)
      set({ isLoading: false })
    }
  },

  loadProjects: async () => {
    try {
      const projects = await window.api.projects.list()
      set({ projects })
    } catch (err) {
      console.error('Failed to load projects:', err)
    }
  },

  loadMessages: async (sessionId: string) => {
    const existing = get().messages[sessionId]
    if (existing) return
    try {
      const msgs = await window.api.sessions.getMessages(sessionId)
      set(state => ({ messages: { ...state.messages, [sessionId]: msgs } }))
    } catch (err) {
      console.error('Failed to load messages:', err)
    }
  },

  loadSettings: async () => {
    try {
      const settings = await window.api.settings.get()
      set({ settings })
    } catch (err) {
      console.error('Failed to load settings:', err)
    }
  },

  selectSession: (sessionId) => {
    set({ selectedSessionId: sessionId })
    if (sessionId) {
      get().loadMessages(sessionId)
    }
  },

  updateSession: (session) => {
    set(state => ({
      sessions: state.sessions.map(s => s.id === session.id ? session : s)
    }))
  },

  addSession: (session) => {
    set(state => {
      const exists = state.sessions.some(s => s.id === session.id)
      if (exists) return state
      return { sessions: [session, ...state.sessions] }
    })
  },

  addMessage: (sessionId, message) => {
    set(state => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] ?? []), message]
      }
    }))
  },

  updateSettings: async (partial) => {
    await window.api.settings.update(partial)
    const updated = await window.api.settings.get()
    set({ settings: updated })
  },

  setSidebarView: (view) => set({ sidebarView: view }),

  deleteSession: async (id) => {
    await window.api.sessions.delete(id)
    set(state => ({
      sessions: state.sessions.filter(s => s.id !== id),
      selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
      messages: Object.fromEntries(Object.entries(state.messages).filter(([k]) => k !== id))
    }))
  },

  updateSessionTitle: async (id, title) => {
    await window.api.sessions.updateTitle(id, title)
    set(state => ({
      sessions: state.sessions.map(s => s.id === id ? { ...s, title } : s)
    }))
  },

  openTerminalForSession: async (sessionId, projectPath) => {
    const currentTerminal = get().terminalSessionId
    // Close previous terminal if it belongs to a different session
    if (currentTerminal && currentTerminal !== sessionId) {
      await window.api.terminal.kill(currentTerminal)
    }

    const result = await window.api.terminal.create(sessionId, projectPath)
    if (result.success) {
      set({ terminalSessionId: sessionId, terminalVisible: true })
    }
  },

  launchSessionTerminal: async (launchId, projectPath) => {
    console.log(`[sessionStore] launchSessionTerminal id=${launchId} path=${projectPath}`)
    const currentTerminal = get().terminalSessionId
    if (currentTerminal && currentTerminal !== launchId) {
      console.log(`[sessionStore] killing previous terminal id=${currentTerminal}`)
      await window.api.terminal.kill(currentTerminal)
    }

    const result = await window.api.terminal.create(launchId, projectPath)
    console.log(`[sessionStore] terminal.create result:`, result)
    if (result.success) {
      set({ terminalSessionId: launchId, terminalVisible: true, selectedSessionId: launchId })
      setTimeout(() => {
        const currentId = get().terminalSessionId
        console.log(`[sessionStore] writing 'claude\\r' to terminal id=${currentId} (original launchId=${launchId})`)
        if (currentId) {
          window.api.terminal.write(currentId, 'claude\r')
        }
      }, 600)
    } else {
      console.error(`[sessionStore] terminal.create failed for id=${launchId}`)
    }
  },

  resumeSession: async (sessionId, projectPath) => {
    const currentTerminal = get().terminalSessionId
    if (currentTerminal && currentTerminal !== sessionId) {
      await window.api.terminal.kill(currentTerminal)
    }

    const result = await window.api.terminal.create(sessionId, projectPath)
    if (result.success) {
      set({ terminalSessionId: sessionId, terminalVisible: true })
      setTimeout(() => {
        window.api.terminal.write(sessionId, `claude --resume ${sessionId}\r`)
      }, 500)
    }
  },

  closeTerminal: async () => {
    const sessionId = get().terminalSessionId
    if (sessionId) {
      await window.api.terminal.kill(sessionId)
      set({ terminalSessionId: null, terminalVisible: false })
    }
  },

  toggleTerminalVisible: () => {
    set(state => ({ terminalVisible: !state.terminalVisible }))
  },

  linkTerminal: (launchId, sessionId) => {
    const { terminalSessionId } = get()
    if (terminalSessionId === launchId) {
      set({ terminalSessionId: sessionId })
    }
  },

  replaceSession: (launchId, sessionId, session) => {
    set(state => {
      const sessions = state.sessions.filter(s => s.id !== launchId)
      const alreadyExists = sessions.some(s => s.id === sessionId)
      const nextSessions = alreadyExists ? sessions : [session, ...sessions]
      return {
        sessions: nextSessions,
        selectedSessionId: state.selectedSessionId === launchId ? sessionId : state.selectedSessionId,
        terminalSessionId: state.terminalSessionId === launchId ? sessionId : state.terminalSessionId
      }
    })
  }
}))
