"use client"

import * as React from "react"
import { X } from "lucide-react"

interface ShortcutsDialogProps {
  open: boolean
  onClose: () => void
}

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ["Enter"], description: "Send the message" },
  { keys: ["Shift", "Enter"], description: "New line without sending" },
  { keys: ["Ctrl", "K"], description: "Focus the composer" },
  { keys: ["Ctrl", "B"], description: "Show or hide conversation history" },
  { keys: ["Esc"], description: "Stop a running turn" },
  { keys: ["?"], description: "Open this list" },
]

/**
 * The shortcuts, discoverable rather than folklore.
 *
 * Implemented as a plain overlay rather than a dialog library: it is one panel
 * with one dismiss path, and pulling in a component library for it would cost
 * more than it is worth.
 */
export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const closeRef = React.useRef<HTMLButtonElement>(null)

  // Focus moves into the panel so Escape and Tab behave, and a screen reader
  // lands somewhere meaningful instead of staying behind the overlay.
  React.useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
        className="bg-background/80 absolute inset-0 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="border-border bg-card relative w-full max-w-sm rounded-xl border p-4 shadow-lg"
      >
        <div className="flex items-center">
          <h2 id="shortcuts-title" className="text-foreground text-sm font-medium">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto rounded p-1 outline-none focus-visible:ring-2"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <dl className="mt-3 space-y-2">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.description} className="flex items-center gap-3">
              <dt className="flex shrink-0 items-center gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="border-border bg-background text-foreground rounded border px-1.5 py-0.5 font-mono text-[10px] leading-4"
                  >
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="text-muted-foreground text-xs">{shortcut.description}</dd>
            </div>
          ))}
        </dl>

        <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
          On macOS use Cmd where Ctrl is shown.
        </p>
      </div>
    </div>
  )
}
