"use client"

import * as React from "react"
import { isToolError, type ChatResponse } from "@/lib/api"
import { cn } from "@/lib/utils"

interface SessionSummaryProps {
  responses: ChatResponse[]
}

interface ToolUse {
  name: string
  calls: number
  errors: number
}

/**
 * What this conversation has actually exercised so far.
 *
 * Aimed at the person auditing the run rather than the person chatting: the
 * question it answers is "which tools has this actually hit, and did any of
 * them fail", which otherwise means expanding every turn to find out.
 *
 * Every number is counted from real responses. Nothing is estimated.
 */
export function SessionSummary({ responses }: SessionSummaryProps) {
  const stats = React.useMemo(() => {
    const tools = new Map<string, ToolUse>()
    let tokens = 0
    let durationMs = 0
    let failed = 0

    for (const response of responses) {
      durationMs += response.duration_ms
      if (response.status === "provider_error") failed += 1
      for (const span of response.spans) tokens += span.tokens ?? 0
      for (const event of response.tool_events) {
        const entry = tools.get(event.tool) ?? { name: event.tool, calls: 0, errors: 0 }
        entry.calls += 1
        if (isToolError(event.result)) entry.errors += 1
        tools.set(event.tool, entry)
      }
    }

    return {
      tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
      tokens,
      durationMs,
      failed,
    }
  }, [responses])

  if (responses.length === 0) return null

  return (
    <section
      aria-label="Session summary"
      className="border-border bg-card/50 mb-6 rounded-lg border px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Figure label="turns" value={String(responses.length)} />
        <Figure label="time" value={`${(stats.durationMs / 1000).toFixed(1)}s`} />
        {stats.tokens > 0 && (
          <Figure label="tokens" value={stats.tokens.toLocaleString("en-US")} />
        )}
        {stats.failed > 0 && (
          <Figure label="failed" value={String(stats.failed)} tone="bad" />
        )}
      </div>

      {stats.tools.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {stats.tools.map((tool) => (
            <span
              key={tool.name}
              title={
                tool.errors > 0
                  ? `${tool.name}: ${tool.calls} call(s), ${tool.errors} returned an error`
                  : `${tool.name}: ${tool.calls} call(s)`
              }
              className={cn(
                "rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-4",
                tool.errors > 0
                  ? "border-destructive/50 text-destructive"
                  : "border-border text-muted-foreground"
              )}
            >
              {tool.name}
              {tool.calls > 1 && <span className="opacity-70"> ×{tool.calls}</span>}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "bad"
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "bad" ? "text-destructive" : "text-foreground"
        )}
      >
        {value}
      </span>
      <span className="text-muted-foreground font-mono text-[10px]">{label}</span>
    </span>
  )
}
