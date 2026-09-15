/**
 * Transcript assembly and download.
 *
 * The shape deliberately mirrors what `starter_v0/chat.py` writes for a CLI
 * session, down to the field names, so a transcript saved from the UI can be
 * committed as lab evidence next to a CLI one and read the same way. The only
 * additions are `source` and the measured `spans`, which the CLI has no way to
 * record.
 */

import type { ChatResponse, ArtifactVersion } from "@/lib/api"
import type { TraceSpan } from "@/components/ui/agent-trace"

export interface TranscriptTurn {
  turn_index: number
  started_at: string
  ended_at: string
  user: string
  status: string
  assistant_text: string
  reply: string
  rounds: ChatResponse["rounds"]
  tool_events: ChatResponse["tool_events"]
  spans: TraceSpan[]
  duration_ms: number
  retries: number
  error: string | null
}

export interface Transcript {
  transcript_id: string
  source: "ui"
  version: string
  artifact_version: string
  prompt_hash: string
  tools_hash: string
  provider: string
  model: string
  created_at: string
  updated_at: string
  turns: TranscriptTurn[]
}

/** `2026-09-14T18:42:07` - local time, seconds precision, matching chat.py's now_iso(). */
export function nowIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** `v0_gemini_20260914T184207` - the same three parts chat.py uses for its filenames. */
export function transcriptId(artifact: ArtifactVersion | null, provider: string): string {
  const stamp = nowIso().replace(/[-:]/g, "")
  return `${artifact?.version ?? "v0"}_${provider || "gemini"}_${stamp}`
}

export function buildTranscript(
  turns: TranscriptTurn[],
  artifact: ArtifactVersion | null,
  provider: string,
  model: string,
  createdAt: string,
  id: string
): Transcript {
  return {
    transcript_id: id,
    source: "ui",
    version: artifact?.version ?? "unknown",
    artifact_version: artifact?.artifact_version ?? "unknown",
    prompt_hash: artifact?.prompt_hash ?? "",
    tools_hash: artifact?.tools_hash ?? "",
    provider,
    model,
    created_at: createdAt,
    updated_at: nowIso(),
    turns,
  }
}

/**
 * Save the transcript as a file. Uses an object URL rather than a data URL
 * because a long session exceeds what a data URL can carry in some browsers.
 */
export function downloadTranscript(transcript: Transcript): void {
  const blob = new Blob([JSON.stringify(transcript, null, 2)], {
    type: "application/json",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${transcript.transcript_id}.transcript.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
