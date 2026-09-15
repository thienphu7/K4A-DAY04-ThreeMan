import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * The agent's reply is plain prose almost all of the time - except when the
 * turn went through `format_incident_report`, which hands back Markdown. Those
 * replies used to render with the asterisks showing: "**VPN Production
 * Incident (INC-1042)**".
 *
 * This renders the small subset the agent actually emits - bold, inline code,
 * and "-" bullets - and leaves everything else as literal text. It builds React
 * elements rather than HTML, so there is no injection surface: an unrecognised
 * construct is displayed, never executed. A full Markdown dependency would buy
 * tables and links the agent never produces.
 */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(INLINE).map((piece, index) => {
    const key = `${keyPrefix}.${index}`
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      return (
        <strong key={key} className="text-foreground font-semibold">
          {piece.slice(2, -2)}
        </strong>
      )
    }
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code key={key} className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
          {piece.slice(1, -1)}
        </code>
      )
    }
    return <React.Fragment key={key}>{piece}</React.Fragment>
  })
}

type Block = { kind: "paragraph"; lines: string[] } | { kind: "list"; items: string[] }

/**
 * A blank line ends the current paragraph; consecutive "-" lines collect into
 * one list. Nothing else changes the shape of the text.
 */
function toBlocks(source: string): Block[] {
  const blocks: Block[] = []
  let paragraphOpen = false

  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line) {
      paragraphOpen = false
      continue
    }

    const last = blocks[blocks.length - 1]
    const bullet = /^[-*]\s+(.*)$/.exec(line)

    if (bullet) {
      paragraphOpen = false
      if (last?.kind === "list") last.items.push(bullet[1])
      else blocks.push({ kind: "list", items: [bullet[1]] })
      continue
    }

    if (paragraphOpen && last?.kind === "paragraph") {
      last.lines.push(line)
    } else {
      blocks.push({ kind: "paragraph", lines: [line] })
      paragraphOpen = true
    }
  }

  return blocks
}

interface ReplyTextProps {
  text: string
  className?: string
}

export function ReplyText({ text, className }: ReplyTextProps) {
  const blocks = React.useMemo(() => toBlocks(text), [text])

  return (
    <div className={cn("text-foreground space-y-2 text-sm leading-relaxed", className)}>
      {blocks.map((block, index) =>
        block.kind === "list" ? (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item, `${index}.${itemIndex}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={index} className="whitespace-pre-wrap">
            {renderInline(block.lines.join("\n"), `${index}`)}
          </p>
        )
      )}
    </div>
  )
}
