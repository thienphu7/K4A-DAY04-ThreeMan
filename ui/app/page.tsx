"use client"

import * as React from "react"
import { CornerDownLeft, Loader2, Square } from "lucide-react"
import { HistorySidebar } from "@/components/history-sidebar"
import { RunHeader, type ConnectionState } from "@/components/run-header"
import { TurnCard, type Turn } from "@/components/turn-card"
import {
  ApiError,
  deleteConversation,
  fetchConversations,
  fetchMeta,
  loadConversation,
  sendChat,
  type ArtifactVersion,
  type ChatHistoryItem,
  type ChatResponse,
  type ConversationSummary,
  type MetaResponse,
  type StoredTurn,
} from "@/lib/api"
import {
  buildTranscript,
  downloadTranscript,
  nowIso,
  transcriptId,
  type TranscriptTurn,
} from "@/lib/transcript"

/** Starting points that exercise the flows the lab wants evidence for. */
const EXAMPLES = [
  { text: "VPN production co dang bi loi khong?", note: "Shared service status" },
  { text: "Laptop LT-318 khong vao duoc VPN, kiem tra giup minh.", note: "One device, by asset ID" },
  { text: "Kiem tra thiet bi giup minh.", note: "Missing identifier, the agent should ask" },
  { text: "Mo ticket cho su co VPN cua LT-318.", note: "Write action, needs confirmation" },
]

const TRACE_PREFERENCE_KEY = "helpdesk-agent:show-trace"

/** Rebuild the response shape a turn card renders from a stored row. */
function turnFromStored(stored: StoredTurn): Turn {
  const response: ChatResponse = {
    status: stored.status,
    error: stored.error,
    reply: stored.reply ?? "",
    assistant_text: stored.assistant_text ?? "",
    structured_output: stored.structured_output,
    rounds: stored.rounds ?? [],
    tool_events: stored.tool_events ?? [],
    spans: stored.spans ?? [],
    duration_ms: stored.duration_ms ?? 0,
    model: stored.model ?? "",
    provider: stored.provider ?? "",
    artifact: {
      version: "",
      artifact_version: stored.artifact_version ?? "",
      prompt_hash: stored.prompt_hash ?? "",
      tools_hash: stored.tools_hash ?? "",
    },
    retries: stored.retries ?? 0,
    conversation_id: null,
  }
  return { id: stored.id, index: stored.turn_index, user: stored.user_message, response }
}

export default function Page() {
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [meta, setMeta] = React.useState<MetaResponse | null>(null)
  const [connection, setConnection] = React.useState<ConnectionState>("checking")
  const [metaError, setMetaError] = React.useState<string | null>(null)
  const [input, setInput] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const [showTrace, setShowTrace] = React.useState(false)

  const [sidebarOpen, setSidebarOpen] = React.useState(false)
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = React.useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = React.useState(false)
  const [historyError, setHistoryError] = React.useState<string | null>(null)

  const sessionRef = React.useRef({ createdAt: nowIso(), id: "" })
  const recordsRef = React.useRef<TranscriptTurn[]>([])
  const abortRef = React.useRef<AbortController | null>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  const historyEnabled = meta?.history_enabled ?? false

  // Open by default on a desktop, closed on a phone where it covers the chat.
  React.useEffect(() => {
    setSidebarOpen(window.matchMedia("(min-width: 1024px)").matches)
    try {
      setShowTrace(window.localStorage.getItem(TRACE_PREFERENCE_KEY) === "1")
    } catch {
      // Private browsing can throw on access. The default is fine.
    }
  }, [])

  const rememberTracePreference = React.useCallback((show: boolean) => {
    setShowTrace(show)
    try {
      window.localStorage.setItem(TRACE_PREFERENCE_KEY, show ? "1" : "0")
    } catch {
      // Not being able to remember the choice is not worth surfacing.
    }
  }, [])

  const loadMeta = React.useCallback((signal?: AbortSignal) => {
    setConnection("checking")
    fetchMeta(signal)
      .then((value) => {
        setMeta(value)
        setConnection("online")
        setMetaError(null)
        if (!sessionRef.current.id) {
          sessionRef.current.id = transcriptId(value.artifact, value.provider)
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        setConnection("offline")
        setMetaError(error instanceof ApiError ? error.message : String(error))
      })
  }, [])

  const refreshHistory = React.useCallback((signal?: AbortSignal) => {
    setHistoryLoading(true)
    setHistoryError(null)
    fetchConversations(signal)
      .then(setConversations)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        setHistoryError(error instanceof ApiError ? error.message : String(error))
      })
      .finally(() => setHistoryLoading(false))
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    loadMeta(controller.signal)
    return () => controller.abort()
  }, [loadMeta])

  React.useEffect(() => {
    if (!historyEnabled) return
    const controller = new AbortController()
    refreshHistory(controller.signal)
    return () => controller.abort()
  }, [historyEnabled, refreshHistory])

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [turns])

  React.useEffect(() => () => abortRef.current?.abort(), [])

  // Shortcuts for the two things done most often, plus an escape hatch.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault()
        setSidebarOpen((open) => !open)
      } else if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault()
        inputRef.current?.focus()
      } else if (event.key === "Escape" && abortRef.current) {
        abortRef.current.abort()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const artifact: ArtifactVersion | null = meta?.artifact ?? null

  function historyBefore(turnId?: string): ChatHistoryItem[] {
    // Only settled turns are context. A turn in flight has no answer to carry,
    // and a failed one would teach the model from an empty reply. Retrying
    // excludes everything from that turn onward.
    const cutoff = turnId ? turns.findIndex((turn) => turn.id === turnId) : turns.length
    const upto = cutoff === -1 ? turns.length : cutoff
    return turns.slice(0, upto).flatMap((turn) =>
      turn.response?.reply
        ? [
            { role: "user" as const, content: turn.user },
            { role: "assistant" as const, content: turn.response.reply },
          ]
        : []
    )
  }

  async function run(message: string, turnId: string, index: number, history: ChatHistoryItem[]) {
    const startedAt = nowIso()
    const controller = new AbortController()
    abortRef.current = controller
    setSending(true)

    try {
      const response = await sendChat(message, history, {
        conversationId,
        turnIndex: index,
        signal: controller.signal,
      })
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === turnId
            ? { ...turn, response, transportError: undefined, cancelled: undefined }
            : turn
        )
      )
      recordsRef.current.push({
        turn_index: index,
        started_at: startedAt,
        ended_at: nowIso(),
        user: message,
        status: response.status,
        assistant_text: response.assistant_text,
        reply: response.reply,
        rounds: response.rounds,
        tool_events: response.tool_events,
        spans: response.spans,
        duration_ms: response.duration_ms,
        retries: response.retries,
        error: response.error,
      })
      setConnection("online")
      if (response.conversation_id) {
        setConversationId(response.conversation_id)
        refreshHistory()
      }
    } catch (error: unknown) {
      const stopped = error instanceof DOMException && error.name === "AbortError"
      const detail = error instanceof ApiError ? error.message : String(error)
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === turnId
            ? stopped
              ? { ...turn, cancelled: true, response: undefined }
              : { ...turn, transportError: detail, response: undefined }
            : turn
        )
      )
      if (!stopped) {
        setConnection("offline")
        recordsRef.current.push({
          turn_index: index,
          started_at: startedAt,
          ended_at: nowIso(),
          user: message,
          status: "transport_error",
          assistant_text: "",
          reply: "",
          rounds: [],
          tool_events: [],
          spans: [],
          duration_ms: 0,
          retries: 0,
          error: detail,
        })
      }
    } finally {
      abortRef.current = null
      setSending(false)
      inputRef.current?.focus()
    }
  }

  async function submit(text: string) {
    const message = text.trim()
    if (!message || sending) return
    const index = turns.length + 1
    const id = `turn-${index}-${Date.now()}`
    setTurns((previous) => [...previous, { id, index, user: message }])
    setInput("")
    await run(message, id, index, historyBefore())
  }

  async function retry(turn: Turn) {
    if (sending) return
    const history = historyBefore(turn.id)
    setTurns((previous) =>
      previous.map((item) =>
        item.id === turn.id
          ? { ...item, response: undefined, transportError: undefined, cancelled: undefined }
          : item
      )
    )
    await run(turn.user, turn.id, turn.index, history)
  }

  function startNew() {
    if (sending) return
    setTurns([])
    setConversationId(null)
    recordsRef.current = []
    sessionRef.current = {
      createdAt: nowIso(),
      id: transcriptId(artifact, meta?.provider ?? "gemini"),
    }
    inputRef.current?.focus()
  }

  async function openConversation(id: string) {
    if (sending) return
    setHistoryError(null)
    try {
      const loaded = await loadConversation(id)
      setTurns(loaded.turns.map(turnFromStored))
      setConversationId(id)
      // A reopened conversation is read from the database, so the in-session
      // transcript buffer no longer describes what is on screen. Clearing it
      // keeps Download honest rather than mixing two runs into one file.
      recordsRef.current = []
      if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(false)
    } catch (error: unknown) {
      setHistoryError(error instanceof ApiError ? error.message : String(error))
    }
  }

  async function removeConversation(id: string) {
    try {
      await deleteConversation(id)
      setConversations((previous) => previous.filter((item) => item.id !== id))
      if (id === conversationId) startNew()
    } catch (error: unknown) {
      setHistoryError(error instanceof ApiError ? error.message : String(error))
    }
  }

  function onDownload() {
    downloadTranscript(
      buildTranscript(
        recordsRef.current,
        artifact,
        meta?.provider ?? "gemini",
        meta?.model ?? "",
        sessionRef.current.createdAt,
        sessionRef.current.id || transcriptId(artifact, meta?.provider ?? "gemini")
      )
    )
  }

  return (
    <div className="flex min-h-dvh">
      {historyEnabled && (
        <HistorySidebar
          open={sidebarOpen}
          conversations={conversations}
          activeId={conversationId}
          loading={historyLoading}
          error={historyError}
          busy={sending}
          onClose={() => setSidebarOpen(false)}
          onNew={startNew}
          onOpen={openConversation}
          onDelete={removeConversation}
          onRetry={() => refreshHistory()}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <RunHeader
          artifact={artifact}
          model={meta?.model ?? ""}
          provider={meta?.provider ?? ""}
          connection={connection}
          // From state, not the ref: a ref mutation would not re-enable the
          // download and clear buttons until something else re-rendered.
          turnCount={turns.length}
          busy={sending}
          showSidebarToggle={historyEnabled}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onDownload={onDownload}
          onClear={startNew}
        />

        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
          {connection === "offline" && (
            <div className="border-destructive/40 bg-destructive/5 mb-6 flex flex-wrap items-start gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="text-destructive text-xs font-medium">Agent API not reachable</p>
                <p className="text-foreground/80 mt-1 text-xs leading-relaxed">
                  {metaError ?? "The agent did not answer."}
                </p>
                <p className="text-muted-foreground mt-2 font-mono text-[11px]">
                  Running locally? The Python side is a separate process: python
                  scripts/local_api.py
                </p>
              </div>
              <button
                type="button"
                onClick={() => loadMeta()}
                className="border-border text-foreground hover:bg-muted focus-visible:ring-ring shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-2"
              >
                Retry connection
              </button>
            </div>
          )}

          {turns.length === 0 ? (
            <EmptyState onPick={submit} disabled={sending || connection === "offline"} />
          ) : (
            <div className="space-y-8">
              {turns.map((turn) => (
                <TurnCard
                  key={turn.id}
                  turn={turn}
                  onRetry={retry}
                  busy={sending}
                  showTrace={showTrace}
                  onShowTraceChange={rememberTracePreference}
                />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </main>

        <footer className="border-border bg-card/80 sticky bottom-0 border-t backdrop-blur">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit(input)
            }}
            className="mx-auto w-full max-w-4xl px-4 py-3"
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter adds a line. isComposing matters
                  // for Vietnamese input: an IME commit also arrives as Enter.
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void submit(input)
                  }
                }}
                rows={1}
                disabled={sending}
                placeholder="Ask the helpdesk agent something"
                aria-label="Message to the helpdesk agent"
                className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring max-h-40 min-h-[2.5rem] flex-1 resize-y rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-60"
              />

              {sending ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="border-border text-foreground hover:bg-muted focus-visible:ring-ring inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-4 text-sm font-medium outline-none focus-visible:ring-2"
                >
                  <Square aria-hidden="true" className="size-3 fill-current" />
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  title={!input.trim() ? "Type a message first" : "Send"}
                  className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-4 text-sm font-medium outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CornerDownLeft aria-hidden="true" className="size-3.5" />
                  Send
                </button>
              )}
            </div>

            <p className="text-muted-foreground mt-1.5 font-mono text-[10px]">
              {sending ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 aria-hidden="true" className="size-2.5 animate-spin" />
                  Running. Esc stops it; nothing has been written yet.
                </span>
              ) : (
                "Enter to send, Shift+Enter for a new line, Ctrl+K to focus"
              )}
            </p>
          </form>
        </footer>
      </div>
    </div>
  )
}

function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="py-10">
      <h2 className="text-foreground text-lg font-medium">Start a conversation</h2>
      <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed">
        Every turn shows the tools the agent chose, the arguments it passed and what each tool
        returned. Open the timeline on any turn for the millisecond breakdown.
      </p>

      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {EXAMPLES.map((example) => (
          <button
            key={example.text}
            type="button"
            disabled={disabled}
            onClick={() => onPick(example.text)}
            className="border-border hover:bg-muted focus-visible:ring-ring rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-foreground block text-sm">{example.text}</span>
            <span className="text-muted-foreground mt-1 block font-mono text-[11px]">
              {example.note}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
