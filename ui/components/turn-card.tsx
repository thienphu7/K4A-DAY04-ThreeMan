"use client"

import * as React from "react"
import { Activity, Check, Copy, RefreshCw, TriangleAlert, User } from "lucide-react"
import { AgentTrace } from "@/components/ui/agent-trace"
import { JsonViewer } from "@/components/json-viewer"
import { ToolEventList } from "@/components/tool-event-list"
import { STATUS_LABEL, type ChatResponse, type RunStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface Turn {
  id: string
  index: number
  user: string
  /** Absent while the turn is still in flight. */
  response?: ChatResponse
  /** Set when the request itself failed, as opposed to the run failing. */
  transportError?: string
  /** Set when the reader stopped the request on purpose. */
  cancelled?: boolean
}

const STATUS_STYLE: Record<RunStatus, string> = {
  answered: "border-primary/40 text-primary",
  waiting_for_user: "border-border text-foreground/80",
  max_tool_rounds: "border-border text-foreground/80",
  provider_error: "border-destructive/50 text-destructive",
}

interface TurnCardProps {
  turn: Turn
  /** Re-sends this turn's message. Present on every outcome that can be retried. */
  onRetry: (turn: Turn) => void
  busy: boolean
  /** Whether the timeline starts open. Remembered across turns by the page. */
  showTrace: boolean
  onShowTraceChange: (show: boolean) => void
}

export function TurnCard({ turn, onRetry, busy, showTrace, onShowTraceChange }: TurnCardProps) {
  return (
    <article className="space-y-3">
      <UserMessage text={turn.user} />

      {turn.cancelled ? (
        <Outcome
          tone="neutral"
          title="Stopped"
          detail="You stopped this turn before the agent finished."
          onRetry={() => onRetry(turn)}
          busy={busy}
        />
      ) : turn.transportError ? (
        <Outcome
          tone="error"
          title="Could not reach the agent"
          detail={turn.transportError}
          onRetry={() => onRetry(turn)}
          busy={busy}
        />
      ) : turn.response ? (
        <AgentAnswer
          turn={turn}
          response={turn.response}
          onRetry={onRetry}
          busy={busy}
          showTrace={showTrace}
          onShowTraceChange={onShowTraceChange}
        />
      ) : (
        <PendingAnswer />
      )}
    </article>
  )
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="border-border text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border">
        <User aria-hidden="true" className="size-3" />
      </span>
      <p className="text-foreground min-w-0 flex-1 text-sm leading-relaxed whitespace-pre-wrap">
        {text}
      </p>
    </div>
  )
}

function AgentAnswer({
  turn,
  response,
  onRetry,
  busy,
  showTrace,
  onShowTraceChange,
}: {
  turn: Turn
  response: ChatResponse
  onRetry: (turn: Turn) => void
  busy: boolean
  showTrace: boolean
  onShowTraceChange: (show: boolean) => void
}) {
  const rounds = response.rounds?.length ?? 0
  // Real tokens off the provider's usage metadata, summed across model spans.
  const tokens = response.spans.reduce((total, span) => total + (span.tokens ?? 0), 0)
  // The envelope is only worth showing when it carried something the reply did
  // not, which is exactly when a grader wants to see it.
  const showEnvelope =
    response.structured_output != null && response.assistant_text !== response.reply
  // A failed run is the one outcome worth offering again: the others are real
  // answers, and re-running them would just spend quota.
  const retryable = response.status === "provider_error"

  return (
    <div className="border-border bg-card space-y-3 rounded-xl border p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4",
            STATUS_STYLE[response.status]
          )}
        >
          {STATUS_LABEL[response.status]}
        </span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {rounds} round{rounds === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
          {(response.duration_ms / 1000).toFixed(2)}s
        </span>
        {response.retries > 0 && (
          <span
            title="The provider rate limited this turn and it was retried automatically."
            className="text-muted-foreground font-mono text-[11px]"
          >
            {response.retries} retr{response.retries === 1 ? "y" : "ies"}
          </span>
        )}

        {tokens > 0 && (
          <span
            title="Tokens billed to this turn, from the provider's usage metadata"
            className="text-muted-foreground font-mono text-[11px] tabular-nums"
          >
            {tokens.toLocaleString("en-US")} tk
          </span>
        )}

        {response.reply && <CopyButton text={response.reply} />}
      </div>

      {response.error && (
        <Outcome
          tone="error"
          title="The run did not finish"
          detail={response.error}
          onRetry={retryable ? () => onRetry(turn) : undefined}
          busy={busy}
        />
      )}

      {response.reply && (
        <p className="text-foreground text-sm leading-relaxed whitespace-pre-wrap">
          {response.reply}
        </p>
      )}

      {response.status === "waiting_for_user" && (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs">
          The agent paused to ask you something. Answer in the box below and it will carry on
          from here.
        </p>
      )}

      {/* The timeline is opt-in. Most of the time the reply and the tool calls
          are the answer; the millisecond breakdown is something you go looking
          for when a run behaved oddly, so it should not sit in the way of
          reading the conversation. The choice is remembered across turns. */}
      {response.spans.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => onShowTraceChange(!showTrace)}
            aria-expanded={showTrace}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded font-mono text-[11px] outline-none focus-visible:ring-2"
          >
            <Activity aria-hidden="true" className="size-3" />
            {showTrace ? "Hide timeline" : `Timeline (${response.spans.length} spans)`}
          </button>

          {showTrace && (
            <div className="mt-2">
              <AgentTrace
                spans={response.spans}
                duration={response.duration_ms}
                runId={`turn_${turn.index}`}
                model={response.model}
                autoPlay={false}
                // A finished run is the useful resting state: this is evidence
                // to read, not a loop to watch, so it starts at the end.
                defaultTime={response.duration_ms}
                rowHeight={32}
                labelWidth={180}
              />
            </div>
          )}
        </div>
      )}

      {response.tool_events.length > 0 ? (
        <ToolEventList events={response.tool_events} />
      ) : (
        <p className="text-muted-foreground font-mono text-[11px]">
          No tools were called on this turn.
        </p>
      )}

      {showEnvelope && (
        <details>
          <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer rounded font-mono text-[11px] underline underline-offset-2 outline-none focus-visible:ring-2">
            Raw model output
          </summary>
          <div className="mt-2">
            <JsonViewer value={response.structured_output} />
          </div>
        </details>
      )}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        } catch {
          // Clipboard is blocked over plain http in some browsers. The reply is
          // selectable regardless, so there is nothing to recover from.
        }
      }}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] outline-none focus-visible:ring-2"
    >
      {copied ? (
        <>
          <Check aria-hidden="true" className="text-primary size-3" />
          copied
        </>
      ) : (
        <>
          <Copy aria-hidden="true" className="size-3" />
          copy reply
        </>
      )}
    </button>
  )
}

/** Skeleton shaped like the answer it replaces, so nothing jumps when it lands. */
function PendingAnswer() {
  return (
    <div
      role="status"
      aria-label="Running the agent"
      className="border-border bg-card space-y-3 rounded-xl border p-3 sm:p-4"
    >
      <div className="flex items-center gap-3">
        <span className="bg-muted h-4 w-20 animate-pulse rounded-full" />
        <span className="bg-muted h-3 w-14 animate-pulse rounded-full" />
      </div>
      <div className="space-y-2">
        <span className="bg-muted block h-3 w-full animate-pulse rounded" />
        <span className="bg-muted block h-3 w-4/5 animate-pulse rounded" />
      </div>
      <div className="border-border space-y-2 rounded-lg border p-3">
        <span className="bg-muted block h-2.5 w-2/3 animate-pulse rounded-full" />
        <span className="bg-muted block h-2.5 w-1/2 animate-pulse rounded-full" />
      </div>
      <p className="text-muted-foreground font-mono text-[11px]">
        Calling the model and its tools. This usually takes 5 to 15 seconds.
      </p>
    </div>
  )
}

/** Any outcome that is not a plain answer, always carrying a way forward. */
function Outcome({
  tone,
  title,
  detail,
  onRetry,
  busy,
}: {
  tone: "error" | "neutral"
  title: string
  detail: string
  onRetry?: () => void
  busy: boolean
}) {
  const error = tone === "error"
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-2.5 rounded-lg border p-3",
        error ? "border-destructive/40 bg-destructive/5" : "border-border"
      )}
    >
      {error && (
        <TriangleAlert aria-hidden="true" className="text-destructive mt-0.5 size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs font-medium", error ? "text-destructive" : "text-foreground")}>
          {title}
        </p>
        <p className="text-foreground/80 mt-1 text-xs leading-relaxed">{detail}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          title={busy ? "Wait for the current turn to finish" : "Send this message again"}
          className="border-border text-foreground hover:bg-muted focus-visible:ring-ring inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Try again
        </button>
      )}
    </div>
  )
}
