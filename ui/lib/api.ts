/**
 * Types and fetch helpers for the Python agent API.
 *
 * The shapes here mirror what ui/api/_agent.py actually returns. They are not a
 * guess at a convenient client model: `spans` is passed to <AgentTrace /> with
 * no transformation, and `tool_events` is rendered as-is so a grader is looking
 * at the tool's real output rather than a prettified version of it.
 */

import type { TraceSpan } from "@/components/ui/agent-trace"

export type RunStatus = "answered" | "waiting_for_user" | "max_tool_rounds" | "provider_error"

export interface ArtifactVersion {
  version: string
  artifact_version: string
  prompt_hash: string
  tools_hash: string
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface ToolEvent {
  tool: string
  args: Record<string, unknown>
  /** Whatever the tool returned. An object with an `error` key means it failed. */
  result: unknown
}

export interface RoundRecord {
  round: number
  assistant_text: string | null
  tool_calls: ToolCall[]
  tool_results: ToolEvent[]
}

export interface ChatResponse {
  status: RunStatus
  error: string | null
  /** The human-readable answer, already unwrapped from any JSON envelope. */
  reply: string
  /** The model's raw text, before unwrapping. Shown when it differs from `reply`. */
  assistant_text: string
  /** Parsed envelope when the prompt asked for one, e.g. intent/action/reply/evidence_ids. */
  structured_output: Record<string, unknown> | null
  rounds: RoundRecord[]
  tool_events: ToolEvent[]
  /** Measured timings, ready for <AgentTrace />. */
  spans: TraceSpan[]
  duration_ms: number
  model: string
  provider: string
  artifact: ArtifactVersion
  /** How many provider calls had to be retried, usually after a rate limit. */
  retries: number
  /** Set once the turn has been stored; null when history is not configured. */
  conversation_id: string | null
}

export interface MetaResponse {
  ok: boolean
  artifact: ArtifactVersion
  model: string
  provider: string
  lab_root: string
  /** False when no database is configured, so the UI can hide history entirely. */
  history_enabled: boolean
}

/** A row in the history list. Carries no turns: those load on demand. */
export interface ConversationSummary {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  turn_count: number
  last_status: RunStatus | null
  model: string | null
}

/** One stored turn, as it comes back from the database. */
export interface StoredTurn {
  id: string
  turn_index: number
  created_at: string
  user_message: string
  status: RunStatus
  reply: string | null
  assistant_text: string | null
  error: string | null
  structured_output: Record<string, unknown> | null
  rounds: RoundRecord[]
  tool_events: ToolEvent[]
  spans: TraceSpan[]
  duration_ms: number | null
  retries: number
  artifact_version: string | null
  prompt_hash: string | null
  tools_hash: string | null
  provider: string | null
  model: string | null
}

export interface LoadedConversation {
  conversation: ConversationSummary & {
    prompt_hash?: string | null
    tools_hash?: string | null
    provider?: string | null
  }
  turns: StoredTurn[]
}

export interface ChatHistoryItem {
  role: "user" | "assistant"
  content: string
}

/** Raised for transport and non-200 responses, so callers handle one error type. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind?: string
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function readError(response: Response): Promise<never> {
  let message = `Request failed with status ${response.status}.`
  let kind: string | undefined
  try {
    const body = await response.json()
    if (typeof body?.message === "string" && body.message.trim()) message = body.message
    if (typeof body?.error === "string") kind = body.error
  } catch {
    // A non-JSON error body tells us nothing more than the status already did.
  }
  throw new ApiError(message, response.status, kind)
}

export async function fetchMeta(signal?: AbortSignal): Promise<MetaResponse> {
  let response: Response
  try {
    response = await fetch("/api/meta", { signal, cache: "no-store" })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new ApiError("Could not reach the agent API. Is the Python server running?")
  }
  if (!response.ok) await readError(response)
  return (await response.json()) as MetaResponse
}

export async function sendChat(
  message: string,
  history: ChatHistoryItem[],
  options: { conversationId?: string | null; turnIndex?: number; signal?: AbortSignal } = {}
): Promise<ChatResponse> {
  const { conversationId, turnIndex, signal } = options
  let response: Response
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history,
        conversation_id: conversationId ?? null,
        turn_index: turnIndex ?? null,
      }),
      signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new ApiError("Could not reach the agent API. Is the Python server running?")
  }
  if (!response.ok) await readError(response)
  return (await response.json()) as ChatResponse
}

export async function fetchConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
  let response: Response
  try {
    response = await fetch("/api/history", { signal, cache: "no-store" })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new ApiError("Could not load history.")
  }
  if (!response.ok) await readError(response)
  const body = (await response.json()) as { conversations?: ConversationSummary[] }
  return body.conversations ?? []
}

export async function loadConversation(
  id: string,
  signal?: AbortSignal
): Promise<LoadedConversation> {
  let response: Response
  try {
    response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, {
      signal,
      cache: "no-store",
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new ApiError("Could not open that conversation.")
  }
  if (!response.ok) await readError(response)
  return (await response.json()) as LoadedConversation
}

export async function deleteConversation(id: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" })
  } catch {
    throw new ApiError("Could not delete that conversation.")
  }
  if (!response.ok) await readError(response)
}

/** True when a tool returned an error object rather than a result. */
export function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result
}

/** Short label for a run status, used on the turn header. */
export const STATUS_LABEL: Record<RunStatus, string> = {
  answered: "answered",
  waiting_for_user: "needs input",
  max_tool_rounds: "round limit",
  provider_error: "failed",
}
