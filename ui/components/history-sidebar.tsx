"use client"

import * as React from "react"
import { MessageSquare, Plus, Trash2, X } from "lucide-react"
import type { ConversationSummary, RunStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

interface HistorySidebarProps {
  open: boolean
  conversations: ConversationSummary[]
  activeId: string | null
  loading: boolean
  error: string | null
  busy: boolean
  onClose: () => void
  onNew: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRetry: () => void
}

/** Coarse on purpose: an exact timestamp is noise in a list you scan. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const seconds = Math.max(0, (Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

/** Only a failed run is worth colouring; the rest would be decoration. */
const STATUS_TONE: Partial<Record<RunStatus, string>> = {
  provider_error: "bg-destructive",
  waiting_for_user: "bg-muted-foreground",
}

export function HistorySidebar({
  open,
  conversations,
  activeId,
  loading,
  error,
  busy,
  onClose,
  onNew,
  onOpen,
  onDelete,
  onRetry,
}: HistorySidebarProps) {
  return (
    <>
      {/* Below `lg` the sidebar is an overlay, so it needs a scrim to dismiss. */}
      {open && (
        <button
          type="button"
          aria-label="Close history"
          onClick={onClose}
          className="bg-background/70 fixed inset-0 z-30 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        // `hidden` rather than a width transition: an aside that is merely zero
        // pixels wide is still in the tab order, which strands keyboard users.
        hidden={!open}
        aria-label="Conversation history"
        className={cn(
          "bg-card border-border z-40 flex w-[min(19rem,85vw)] shrink-0 flex-col border-r",
          "fixed inset-y-0 left-0 lg:sticky lg:top-0 lg:h-dvh"
        )}
      >
        <div className="border-border flex items-center gap-2 border-b px-3 py-3">
          <h2 className="text-foreground text-sm font-medium">History</h2>
          <span className="text-muted-foreground font-mono text-[11px]">
            {conversations.length > 0 ? conversations.length : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close history"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto rounded p-1 outline-none focus-visible:ring-2 lg:hidden"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="border-border border-b p-2">
          <button
            type="button"
            onClick={onNew}
            disabled={busy}
            title={busy ? "Wait for the current turn to finish" : "Start a new conversation"}
            className="border-border text-foreground hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            New conversation
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <ul className="space-y-1.5" aria-label="Loading conversations">
              {[0, 1, 2, 3].map((row) => (
                <li key={row} className="border-border rounded-md border p-2.5">
                  <span className="bg-muted block h-3 w-3/4 animate-pulse rounded" />
                  <span className="bg-muted mt-2 block h-2.5 w-1/3 animate-pulse rounded" />
                </li>
              ))}
            </ul>
          ) : error ? (
            <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
              <p className="text-destructive text-xs font-medium">History unavailable</p>
              <p className="text-foreground/80 mt-1 text-xs leading-relaxed">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="border-border text-foreground hover:bg-muted focus-visible:ring-ring mt-2 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2"
              >
                Try again
              </button>
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-2 py-6 text-center">
              <MessageSquare
                aria-hidden="true"
                className="text-muted-foreground/50 mx-auto size-5"
              />
              <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                Conversations are saved here as you go, so you can reopen a run later as
                evidence.
              </p>
            </div>
          ) : (
            <ul className="space-y-1">
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId}
                  busy={busy}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  )
}

function ConversationRow({
  conversation,
  active,
  busy,
  onOpen,
  onDelete,
}: {
  conversation: ConversationSummary
  active: boolean
  busy: boolean
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [confirming, setConfirming] = React.useState(false)
  const tone = conversation.last_status ? STATUS_TONE[conversation.last_status] : undefined

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => onOpen(conversation.id)}
        disabled={busy}
        aria-current={active ? "true" : undefined}
        className={cn(
          "hover:bg-muted focus-visible:ring-ring w-full rounded-md px-2.5 py-2 pr-9 text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
          active && "bg-muted"
        )}
      >
        <span className="text-foreground line-clamp-2 block text-xs leading-snug">
          {conversation.title || "Untitled conversation"}
        </span>
        <span className="text-muted-foreground mt-1 flex items-center gap-1.5 font-mono text-[10px]">
          {tone && <span aria-hidden="true" className={cn("size-1 rounded-full", tone)} />}
          {conversation.turn_count} turn{conversation.turn_count === 1 ? "" : "s"}
          <span aria-hidden="true">·</span>
          {relativeTime(conversation.updated_at)}
        </span>
      </button>

      {/* Two-step delete. There is no undo behind this, so a single misclick
          must not be able to destroy a run someone is using as evidence. */}
      {confirming ? (
        <span className="absolute top-1.5 right-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => {
              setConfirming(false)
              onDelete(conversation.id)
            }}
            className="bg-destructive text-destructive-foreground focus-visible:ring-ring rounded px-1.5 py-1 font-mono text-[10px] outline-none focus-visible:ring-2"
          >
            delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="border-border text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded border px-1.5 py-1 font-mono text-[10px] outline-none focus-visible:ring-2"
          >
            keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          aria-label={`Delete conversation: ${conversation.title ?? "untitled"}`}
          className="text-muted-foreground hover:text-destructive focus-visible:ring-ring absolute top-2 right-1.5 rounded p-1 opacity-0 outline-none transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 disabled:hidden"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </li>
  )
}
