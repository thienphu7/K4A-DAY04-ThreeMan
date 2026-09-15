"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

interface JsonViewerProps {
  value: unknown
  /** Collapse past this many lines until the reader asks for the rest. */
  clampLines?: number
  className?: string
}

/**
 * Raw JSON, shown as JSON.
 *
 * A grader is checking what a tool actually returned, so this deliberately does
 * not prettify, summarise or re-key anything. Long results are clamped rather
 * than truncated, so nothing is ever silently dropped from view.
 */
export function JsonViewer({ value, clampLines = 12, className }: JsonViewerProps) {
  const [expanded, setExpanded] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const text = React.useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      // Circular or otherwise unserialisable: show something rather than crash.
      return String(value)
    }
  }, [value])

  const lines = React.useMemo(() => text.split("\n"), [text])
  const clamped = lines.length > clampLines
  const shown = expanded || !clamped ? text : lines.slice(0, clampLines).join("\n")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard is unavailable over plain http on some browsers. The text is
      // selectable either way, so there is nothing to recover from.
    }
  }

  return (
    <div className={cn("group/json relative", className)}>
      <pre className="border-border bg-background text-foreground/85 max-w-full overflow-x-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">
        {shown}
        {clamped && !expanded ? "\n  ..." : ""}
      </pre>

      <button
        type="button"
        onClick={copy}
        aria-label="Copy JSON"
        className="border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-2 right-2 rounded-md border p-1.5 opacity-0 transition-opacity outline-none group-hover/json:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
      >
        {copied ? (
          <Check aria-hidden="true" className="text-primary size-3" />
        ) : (
          <Copy aria-hidden="true" className="size-3" />
        )}
      </button>

      {clamped && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-1.5 rounded font-mono text-[11px] underline underline-offset-2 outline-none focus-visible:ring-2"
        >
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}
