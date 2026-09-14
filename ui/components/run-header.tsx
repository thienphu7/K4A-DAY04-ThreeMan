"use client"

import { Download, Hash, PanelLeft, RotateCcw } from "lucide-react"
import type { ArtifactVersion } from "@/lib/api"
import { cn } from "@/lib/utils"

export type ConnectionState = "checking" | "online" | "offline"

interface RunHeaderProps {
  artifact: ArtifactVersion | null
  model: string
  provider: string
  connection: ConnectionState
  turnCount: number
  busy: boolean
  /** Hidden when no database is configured, since there would be nothing to show. */
  showSidebarToggle: boolean
  onToggleSidebar: () => void
  onDownload: () => void
  onClear: () => void
}

const CONNECTION_COPY: Record<ConnectionState, { dot: string; label: string }> = {
  checking: { dot: "bg-muted-foreground", label: "Connecting to the agent" },
  online: { dot: "bg-primary", label: "Agent reachable" },
  offline: { dot: "bg-destructive", label: "Agent unreachable" },
}

/**
 * What is running, and which artifacts produced it.
 *
 * The version and both hashes are computed server-side from the files on disk,
 * so this cannot claim a version the deployment is not running. That is the
 * point of showing them: a screenshot of a result is only evidence if it names
 * the prompt and tool declarations that produced it.
 */
export function RunHeader({
  artifact,
  model,
  provider,
  connection,
  turnCount,
  busy,
  showSidebarToggle,
  onToggleSidebar,
  onDownload,
  onClear,
}: RunHeaderProps) {
  const status = CONNECTION_COPY[connection]

  return (
    <header className="border-border bg-card/80 sticky top-0 z-20 border-b backdrop-blur">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {showSidebarToggle && (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label="Toggle conversation history"
              title="Conversation history (Ctrl+B)"
              className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring -ml-1 rounded-md p-1.5 outline-none focus-visible:ring-2"
            >
              <PanelLeft aria-hidden="true" className="size-4" />
            </button>
          )}
          {/* Real state, not decoration: this is the only signal that the Python
              side is actually answering before you spend a turn finding out. */}
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", status.dot)}
          />
          <div className="min-w-0">
            <h1 className="text-foreground text-sm leading-tight font-medium">
              IT Helpdesk Agent
            </h1>
            <p className="text-muted-foreground font-mono text-[11px] leading-tight">
              <span className="sr-only">{status.label}. </span>
              {connection === "offline"
                ? "agent unreachable"
                : model
                  ? `${provider} / ${model}`
                  : "connecting"}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 sm:ml-auto">
          {artifact && (
            <>
              <span className="border-border text-foreground/85 rounded-md border px-2 py-1 font-mono text-[11px] whitespace-nowrap">
                {artifact.artifact_version}
              </span>
              <HashChip label="prompt" value={artifact.prompt_hash} />
              <HashChip label="tools" value={artifact.tools_hash} />
            </>
          )}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onClear}
              disabled={turnCount === 0 || busy}
              title={
                busy
                  ? "Wait for the current turn to finish"
                  : turnCount === 0
                    ? "Nothing to clear yet"
                    : "Clear this conversation"
              }
              className="border-border text-foreground hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Clear
            </button>

            <button
              type="button"
              onClick={onDownload}
              disabled={turnCount === 0}
              // Disabled controls explain themselves. A dead button with no
              // reason is the thing that makes software feel unfinished.
              title={
                turnCount === 0
                  ? "Send a message first, then the transcript can be downloaded"
                  : "Download this conversation as lab evidence"
              }
              className="border-border text-foreground hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download aria-hidden="true" className="size-3.5" />
              Transcript
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}

function HashChip({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <span
      // The full hash is what gets pasted into a report, so it stays reachable
      // even though only the first 12 characters are shown.
      title={`${label}: ${value}`}
      className="text-muted-foreground hidden items-center gap-1 font-mono text-[11px] whitespace-nowrap sm:inline-flex"
    >
      <Hash aria-hidden="true" className="size-3" />
      {label} {value.slice(0, 12)}
    </span>
  )
}
