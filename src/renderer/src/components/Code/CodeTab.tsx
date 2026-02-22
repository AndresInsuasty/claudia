import React, { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, ChevronRight, Check, X, MessageSquare, Loader, Bot, GitCommit, ChevronDown, Copy } from 'lucide-react'
import type { Session } from '../../../../shared/types'

interface DiffFile {
  path: string
  additions: number
  deletions: number
  status: 'pending' | 'accepted' | 'rejected'
  diff?: string
  review?: string
  reviewLoading?: boolean
}

interface Props {
  session: Session
}

type ReviewType = 'summary' | 'syntax' | 'security' | 'custom'

function DiffLine({ line }: { line: string }): React.JSX.Element {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return <div className="text-claude-muted font-mono text-xs py-0.5 px-2">{line}</div>
  }
  if (line.startsWith('+')) {
    return <div className="bg-green-950/40 text-green-300 font-mono text-xs py-0.5 px-2 whitespace-pre">{line}</div>
  }
  if (line.startsWith('-')) {
    return <div className="bg-red-950/40 text-red-300 font-mono text-xs py-0.5 px-2 whitespace-pre">{line}</div>
  }
  if (line.startsWith('@@')) {
    return <div className="text-blue-400 font-mono text-xs py-0.5 px-2 bg-blue-950/20">{line}</div>
  }
  return <div className="text-claude-muted font-mono text-xs py-0.5 px-2 whitespace-pre">{line}</div>
}

const REVIEW_COLORS: Record<string, { border: string; bg: string; text: string; prose: string }> = {
  summary: { border: 'border-blue-400/30', bg: 'bg-blue-400/5', text: 'text-blue-400', prose: 'prose-headings:text-blue-400 prose-code:text-blue-400' },
  syntax:  { border: 'border-green-400/30', bg: 'bg-green-400/5', text: 'text-green-400', prose: 'prose-headings:text-green-400 prose-code:text-green-400' },
  security:{ border: 'border-purple-400/30', bg: 'bg-purple-400/5', text: 'text-purple-400', prose: 'prose-headings:text-purple-400 prose-code:text-purple-400' },
  custom:  { border: 'border-cyan-400/30', bg: 'bg-cyan-400/5', text: 'text-cyan-400', prose: 'prose-headings:text-cyan-400 prose-code:text-cyan-400' },
  file:    { border: 'border-claude-orange/30', bg: 'bg-claude-orange/5', text: 'text-claude-orange', prose: 'prose-headings:text-claude-orange prose-code:text-claude-orange' }
}

const REVIEW_TITLES: Record<string, string> = {
  summary: 'General Summary',
  syntax: 'Syntax Review',
  security: 'Security Review',
  custom: 'Custom Review',
  file: 'File Review'
}

function ReviewCard({ text, loading, variant = 'file', title, collapsed, onToggle }: {
  text?: string; loading?: boolean; variant?: string; title?: string
  collapsed?: boolean; onToggle?: () => void
}): React.JSX.Element | null {
  if (!text && !loading) return null
  const colors = REVIEW_COLORS[variant] ?? REVIEW_COLORS.file
  const label = title ?? REVIEW_TITLES[variant] ?? 'Review'
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`mx-3 mb-2 rounded-lg border ${colors.border} ${colors.bg} p-3`}>
      <div className="flex items-center gap-1.5 cursor-pointer select-none" onClick={onToggle}>
        <ChevronDown size={13} className={`${colors.text} transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        <Bot size={13} className={colors.text} />
        <span className={`text-xs font-medium ${colors.text} flex-1`}>{label}</span>
        {!loading && text && (
          <button
            onClick={e => { e.stopPropagation(); handleCopy() }}
            className="p-0.5 rounded hover:bg-white/10 transition-colors"
            title="Copy review"
          >
            {copied
              ? <Check size={11} className="text-green-400" />
              : <Copy size={11} className="text-claude-muted hover:text-claude-text" />}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="mt-2">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-claude-muted">
              <Loader size={12} className="animate-spin" />
              Analyzing…
            </div>
          ) : (
            <div className={`text-xs text-claude-text leading-relaxed prose prose-invert prose-xs max-w-none
              prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5
              ${colors.prose} prose-headings:text-xs prose-headings:mt-2 prose-headings:mb-1
              prose-strong:text-claude-text prose-code:text-[11px]
              prose-code:bg-claude-hover prose-code:px-1 prose-code:py-0.5 prose-code:rounded
              prose-pre:bg-[#0d0d0d] prose-pre:rounded-md prose-pre:p-2 prose-pre:my-1`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function CodeTab({ session }: Props): React.JSX.Element {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [generalReviews, setGeneralReviews] = useState<Partial<Record<ReviewType, string>>>({})
  const [generalReviewLoading, setGeneralReviewLoading] = useState<Partial<Record<ReviewType, boolean>>>({})
  const [commitLoading, setCommitLoading] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [showReviewMenu, setShowReviewMenu] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [showCustomInput, setShowCustomInput] = useState(false)
  const [requestChangeText, setRequestChangeText] = useState<Record<string, string>>({})
  const [requestChangeSending, setRequestChangeSending] = useState<Record<string, boolean>>({})
  const [collapsedReviews, setCollapsedReviews] = useState<Set<string>>(new Set())

  const loadDiff = useCallback(async () => {
    setLoading(true)
    try {
      const { files: f } = await window.api.git.lastCommitDiff(session.projectPath)
      setFiles(f.map(file => ({ ...file, status: 'pending' })))
      if (f.length > 0) setSelectedFile(f[0].path)
    } finally {
      setLoading(false)
    }
  }, [session.projectPath])

  const loadReviews = useCallback(async () => {
    try {
      const saved = await window.api.reviews.getBySession(session.id)
      const generals: Partial<Record<ReviewType, string>> = {}
      const fileReviews: Record<string, string> = {}
      for (const r of saved) {
        if (r.scope === 'general') {
          generals[r.reviewType as ReviewType] = r.content
        } else if (r.filePath) {
          fileReviews[r.filePath] = r.content
        }
      }
      if (Object.keys(generals).length > 0) setGeneralReviews(generals)
      if (Object.keys(fileReviews).length > 0) {
        setFiles(prev => prev.map(f => fileReviews[f.path] ? { ...f, review: fileReviews[f.path] } : f))
      }
    } catch (err) {
      console.warn('[CodeTab] loadReviews error:', err)
    }
  }, [session.id])

  useEffect(() => { loadDiff().then(() => loadReviews()) }, [loadDiff, loadReviews])

  const loadFileDiff = useCallback(async (filePath: string) => {
    setFiles(prev => prev.map(f => f.path === filePath ? { ...f, diff: f.diff ?? 'loading' } : f))
    const diff = await window.api.git.fileDiff(session.projectPath, filePath)
    setFiles(prev => prev.map(f => f.path === filePath ? { ...f, diff } : f))
  }, [session.projectPath])

  const handleSelectFile = (filePath: string) => {
    setSelectedFile(filePath)
    const file = files.find(f => f.path === filePath)
    if (!file?.diff || file.diff === 'loading') {
      loadFileDiff(filePath)
    }
  }

  const handleAccept = async (filePath: string) => {
    await window.api.git.stageFile(session.projectPath, filePath)
    await window.api.reviews.deleteByFile(session.id, filePath)
    setFiles(prev => {
      const next = prev.filter(f => f.path !== filePath)
      if (selectedFile === filePath) {
        setSelectedFile(next.length > 0 ? next[0].path : null)
      }
      return next
    })
  }

  const handleReject = async (filePath: string) => {
    await window.api.git.revertFile(session.projectPath, filePath)
    await window.api.reviews.deleteByFile(session.id, filePath)
    setFiles(prev => {
      const next = prev.filter(f => f.path !== filePath)
      if (selectedFile === filePath) {
        setSelectedFile(next.length > 0 ? next[0].path : null)
      }
      return next
    })
  }

  const handleReviewFile = async (filePath: string, reviewType: ReviewType) => {
    const file = files.find(f => f.path === filePath)
    if (!file) return

    const prompts: Record<ReviewType, string> = {
      summary: `Run \`git diff -- ${filePath}\` and provide a concise summary of the unstaged changes in this file. Highlight anything unusual or risky.`,
      syntax: `Run \`git diff -- ${filePath}\` and review the unstaged changes for syntax issues and code quality problems. Be concise.`,
      security: `Run \`git diff -- ${filePath}\` and review the unstaged changes for security vulnerabilities. Be concise.`,
      custom: customPrompt ? `Run \`git diff -- ${filePath}\` and ${customPrompt}` : `Run \`git diff -- ${filePath}\` and review the unstaged changes. Be concise.`
    }

    console.log(`[CodeTab] handleReviewFile file=${filePath} type=${reviewType}`)
    console.log(`[CodeTab] handleReviewFile prompt=${prompts[reviewType].slice(0, 120)}…`)
    setFiles(prev => prev.map(f => f.path === filePath ? { ...f, reviewLoading: true } : f))
    const result = await window.api.git.reviewWithClaude({
      projectPath: session.projectPath,
      prompt: prompts[reviewType]
    })
    console.log(`[CodeTab] handleReviewFile result:`, result)
    const content = result.success ? result.response : result.error
    setFiles(prev => prev.map(f => f.path === filePath ? {
      ...f, reviewLoading: false, review: content
    } : f))
    if (content) {
      await window.api.reviews.save(session.id, reviewType, 'file', filePath, content)
    }
  }

  const handleGeneralReview = async (reviewType: ReviewType) => {
    setShowReviewMenu(false)
    const prompts: Record<ReviewType, string> = {
      summary: `Run \`git diff\` and provide a concise general summary of all unstaged changes. Highlight anything unusual or risky.`,
      syntax: `Run \`git diff\` and review all unstaged changes for syntax issues and code quality problems. Be concise.`,
      security: `Run \`git diff\` and review all unstaged changes for security vulnerabilities. Be concise.`,
      custom: customPrompt ? `Run \`git diff\` and ${customPrompt}` : `Run \`git diff\` and review all unstaged changes. Be concise.`
    }
    console.log(`[CodeTab] handleGeneralReview type=${reviewType}`)
    console.log(`[CodeTab] handleGeneralReview prompt=${prompts[reviewType].slice(0, 120)}…`)
    setGeneralReviewLoading(prev => ({ ...prev, [reviewType]: true }))
    const result = await window.api.git.reviewWithClaude({
      projectPath: session.projectPath,
      prompt: prompts[reviewType]
    })
    console.log(`[CodeTab] handleGeneralReview result:`, result)
    const content = result.success ? result.response : result.error
    setGeneralReviews(prev => ({ ...prev, [reviewType]: content }))
    setGeneralReviewLoading(prev => ({ ...prev, [reviewType]: false }))
    if (content) {
      await window.api.reviews.save(session.id, reviewType, 'general', null, content)
    }
  }

  const handleApproveAll = async () => {
    setCommitLoading(true)
    const accepted = files.filter(f => f.status === 'accepted').map(f => f.path)
    const fileList = accepted.length > 0 ? accepted : files.filter(f => f.status !== 'rejected').map(f => f.path)
    console.log(`[CodeTab] handleApproveAll files=${fileList.join(', ')}`)
    const prompt = `The following files have been staged (git add). Create a descriptive commit message and run git commit for them:\n${fileList.join('\n')}`
    const result = await window.api.git.reviewWithClaude({
      projectPath: session.projectPath,
      prompt
    })
    console.log(`[CodeTab] handleApproveAll result:`, result)
    setCommitMsg(result.success ? (result.response ?? 'Committed ✓') : (result.error ?? 'Error'))
    setCommitLoading(false)
    setTimeout(() => loadDiff(), 2000)
  }

  const handleRequestChange = async (filePath: string) => {
    const text = requestChangeText[filePath]
    if (!text?.trim()) return
    setRequestChangeSending(prev => ({ ...prev, [filePath]: true }))
    await window.api.git.reviewWithClaude({
      projectPath: session.projectPath,
      prompt: `Regarding the file ${filePath}: ${text}`
    })
    setRequestChangeText(prev => ({ ...prev, [filePath]: '' }))
    setRequestChangeSending(prev => ({ ...prev, [filePath]: false }))
  }

  const toggleCollapse = (key: string) => {
    setCollapsedReviews(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const selectedFileData = files.find(f => f.path === selectedFile)
  const pendingCount = files.filter(f => f.status === 'pending').length
  const acceptedCount = files.filter(f => f.status === 'accepted').length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size={20} className="animate-spin text-claude-muted" />
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <GitCommit size={32} className="text-claude-muted" />
        <p className="text-sm text-claude-muted">No changes in last commit</p>
        <button onClick={loadDiff} className="text-xs text-claude-orange hover:underline">Refresh</button>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: file list */}
      <div className="w-56 min-w-56 flex flex-col border-r border-claude-border bg-claude-sidebar">
        {/* Header + review/approve buttons */}
        <div className="px-3 py-2 border-b border-claude-border space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-claude-text">Changed Files</span>
            <button onClick={loadDiff} className="text-xs text-claude-muted hover:text-claude-text">↺</button>
          </div>

          {/* General review dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowReviewMenu(m => !m)}
              className="w-full flex items-center justify-between gap-1 px-2 py-1.5 rounded bg-claude-hover text-xs text-claude-text hover:bg-claude-border transition-colors"
            >
              <span className="flex items-center gap-1"><Bot size={11} className="text-claude-orange" /> Review</span>
              <ChevronDown size={11} className="text-claude-muted" />
            </button>
            {showReviewMenu && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-claude-panel border border-claude-border rounded-lg shadow-xl z-20 overflow-hidden">
                {(['summary', 'syntax', 'security'] as ReviewType[]).map(t => (
                  <button key={t} onClick={() => handleGeneralReview(t)}
                    className="w-full px-3 py-2 text-xs text-left text-claude-text hover:bg-claude-hover transition-colors capitalize">
                    {t === 'summary' ? 'General summary' : `${t.charAt(0).toUpperCase() + t.slice(1)} review`}
                  </button>
                ))}
                <button onClick={() => { setShowCustomInput(true); setShowReviewMenu(false) }}
                  className="w-full px-3 py-2 text-xs text-left text-claude-text hover:bg-claude-hover transition-colors border-t border-claude-border">
                  Custom prompt…
                </button>
              </div>
            )}
          </div>

          {showCustomInput && (
            <div className="space-y-1">
              <textarea
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                placeholder="Enter your review prompt…"
                className="w-full bg-claude-hover text-xs text-claude-text rounded p-1.5 resize-none outline-none placeholder-claude-muted"
                rows={2}
              />
              <div className="flex gap-1">
                <button onClick={() => handleGeneralReview('custom')}
                  className="flex-1 py-1 text-xs bg-claude-orange text-white rounded">Go</button>
                <button onClick={() => setShowCustomInput(false)}
                  className="px-2 py-1 text-xs text-claude-muted hover:text-claude-text rounded bg-claude-hover">✕</button>
              </div>
            </div>
          )}

          {/* Approve all */}
          {pendingCount === 0 && acceptedCount > 0 && (
            <button
              onClick={handleApproveAll}
              disabled={commitLoading}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white text-xs transition-colors disabled:opacity-50"
            >
              {commitLoading ? <Loader size={11} className="animate-spin" /> : <GitCommit size={11} />}
              Approve &amp; Commit
            </button>
          )}
          {commitMsg && <p className="text-xs text-green-400 text-center">{commitMsg.slice(0, 80)}</p>}
        </div>

        {/* File rows */}
        <div className="flex-1 overflow-y-auto py-1">
          {files.map(file => (
            <button
              key={file.path}
              onClick={() => handleSelectFile(file.path)}
              className={`w-full flex items-start gap-2 px-2 py-2 hover:bg-claude-hover transition-colors text-left ${
                selectedFile === file.path ? 'bg-claude-hover' : ''
              }`}
            >
              <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${
                file.status === 'accepted' ? 'bg-green-500' :
                file.status === 'rejected' ? 'bg-red-500' : 'bg-claude-muted'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-claude-text truncate font-mono">{file.path.split('/').pop()}</div>
                <div className="text-xs text-claude-muted truncate">{file.path}</div>
                <div className="flex gap-2 mt-0.5">
                  <span className="text-xs text-green-400">+{file.additions}</span>
                  <span className="text-xs text-red-400">-{file.deletions}</span>
                </div>
              </div>
              <ChevronRight size={12} className={`text-claude-muted shrink-0 mt-1 transition-transform ${selectedFile === file.path ? 'rotate-90' : ''}`} />
            </button>
          ))}
        </div>
      </div>

      {/* Right: diff view */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFileData ? (
          <>
            {/* File header + actions */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-claude-border bg-claude-panel shrink-0 flex-wrap">
              <FileText size={13} className="text-claude-muted shrink-0" />
              <span className="text-xs font-mono text-claude-text flex-1 truncate">{selectedFileData.path}</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => handleAccept(selectedFileData.path)}
                  disabled={selectedFileData.status !== 'pending'}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                    selectedFileData.status === 'accepted'
                      ? 'bg-green-800/40 text-green-400 cursor-default'
                      : 'bg-green-900/30 text-green-400 hover:bg-green-800/40 disabled:opacity-40'
                  }`}
                >
                  <Check size={11} /> Accept
                </button>
                <button
                  onClick={() => handleReject(selectedFileData.path)}
                  disabled={selectedFileData.status !== 'pending'}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                    selectedFileData.status === 'rejected'
                      ? 'bg-red-800/40 text-red-400 cursor-default'
                      : 'bg-red-900/30 text-red-400 hover:bg-red-800/40 disabled:opacity-40'
                  }`}
                >
                  <X size={11} /> Reject
                </button>
                <button
                  onClick={() => handleReviewFile(selectedFileData.path, 'summary')}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-claude-hover text-claude-muted hover:text-claude-text transition-colors"
                >
                  <Bot size={11} className="text-claude-orange" /> Review
                </button>
              </div>
            </div>

            {/* Scrollable reviews area */}
            <div className="max-h-[40vh] overflow-y-auto shrink-0 py-1 border-b border-claude-border">
              {/* Stacked general reviews (summary, syntax, security, custom) */}
              {(['summary', 'syntax', 'security', 'custom'] as ReviewType[]).map(rt => (
                (generalReviews[rt] || generalReviewLoading[rt]) ? (
                  <ReviewCard key={rt} variant={rt} text={generalReviews[rt]} loading={generalReviewLoading[rt]}
                    collapsed={collapsedReviews.has(rt)} onToggle={() => toggleCollapse(rt)} />
                ) : null
              ))}

              {/* Per-file review */}
              <ReviewCard variant="file" text={selectedFileData.review} loading={selectedFileData.reviewLoading}
                collapsed={collapsedReviews.has('file')} onToggle={() => toggleCollapse('file')} />
            </div>

            {/* Request change */}
            <div className="px-3 py-2 border-b border-claude-border bg-claude-panel/50 shrink-0">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Request a change on this file…"
                  value={requestChangeText[selectedFileData.path] ?? ''}
                  onChange={e => setRequestChangeText(prev => ({ ...prev, [selectedFileData.path]: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && handleRequestChange(selectedFileData.path)}
                  className="flex-1 bg-claude-hover text-xs text-claude-text placeholder-claude-muted rounded px-2 py-1.5 outline-none"
                />
                <button
                  onClick={() => handleRequestChange(selectedFileData.path)}
                  disabled={requestChangeSending[selectedFileData.path] || !requestChangeText[selectedFileData.path]?.trim()}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-claude-orange text-white text-xs hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {requestChangeSending[selectedFileData.path] ? <Loader size={11} className="animate-spin" /> : <MessageSquare size={11} />}
                  Send
                </button>
              </div>
            </div>

            {/* Diff content */}
            <div className="flex-1 overflow-y-auto overflow-x-auto bg-[#0d0d0d]">
              {!selectedFileData.diff || selectedFileData.diff === 'loading' ? (
                <div className="flex items-center justify-center h-32">
                  <Loader size={16} className="animate-spin text-claude-muted" />
                </div>
              ) : (
                <div>
                  {selectedFileData.diff.split('\n').map((line, i) => (
                    <DiffLine key={i} line={line} />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-claude-muted">Select a file to view diff</p>
          </div>
        )}
      </div>
    </div>
  )
}
