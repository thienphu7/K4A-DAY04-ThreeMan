"use client"

import * as React from "react"
import { ChevronRight, CircleAlert } from "lucide-react"
import { JsonViewer } from "@/components/json-viewer"
import { isToolError, type ToolEvent } from "@/lib/api"
import { cn } from "@/lib/utils"

interface ToolEventListProps {
  events: ToolEvent[]
}

/**
 * Every tool the turn called: its name, the exact arguments the model passed,
 * and what came back.
 *
 * Arguments are always visible because a wrong argument is the failure mode
 * that is easiest to miss and hardest to spot from a summary. The result is one
 * click away so a long run stays readable.
 */
export function ToolEventList({ events }: ToolEventListProps) {
  if (events.length === 0) return null

  return (
    <ul className="divide-border border-border divide-y rounded-lg border">
      {events.map((event, index) => (
        <ToolEventRow key={`${event.tool}-${index}`} event={event} />
      ))}
    </ul>
  )
}

function ToolEventRow({ event }: { event: ToolEvent }) {
  const [open, setOpen] = React.useState(false)
  const failed = isToolError(event.result)
  const argEntries = Object.entries(event.args ?? {})

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-start gap-2 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground font-mono text-xs font-medium">{event.tool}</span>
            {failed && (
              <span className="text-destructive inline-flex items-center gap-1 font-mono text-[11px]">
                <CircleAlert aria-hidden="true" className="size-3" />
                error
              </span>
            )}
          </div>

          {/* Arguments, inline. A wrong argument is the quietest failure mode
              here, so it never hides behind a disclosure. */}
          {argEntries.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {argEntries.map(([key, value]) => (
                <span key={key} className="font-mono text-[11px]">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="text-muted-foreground/60">=</span>
                  <span className="text-foreground/85">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground mt-1 block font-mono text-[11px]">
              no arguments
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pl-8">
          <JsonViewer value={event.result} />
        </div>
      )}
    </li>
  )
}
