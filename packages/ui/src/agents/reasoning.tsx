import { useId, type ReactNode } from "react";
import { AgentDisclosure } from "@apcode/ui/agents/agent-disclosure";
import { ReasoningText } from "@apcode/ui/agents/loading-states/reasoning-text";
import { Chevron, useRevealOpen, type ToolReveal } from "@apcode/ui/agents/tool-group";

/**
 * The agent's thinking, folded to one line so a long think doesn't read as a stall: its latest
 * line while it streams, its first once done. The rest is only read on purpose: `children` is the
 * full text, shown when opened.
 */
export function Reasoning({
  text,
  streaming,
  reveal = null,
  children,
}: {
  text: string;
  streaming: boolean;
  /** Opens it, for a tool call folded inside. */
  reveal?: ToolReveal | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useRevealOpen(reveal);
  const contentId = useId();
  // Harnesses often open with a bold heading; the line shows it as plain text.
  const lines = text
    .replaceAll("**", "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div className="w-full text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
        className="group flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
      >
        {streaming ? (
          <ReasoningText
            // ReasoningText adds its own ellipsis.
            phrases={[lines.at(-1)?.replace(/[.…:]+$/, "") ?? "Thinking"]}
            className="min-w-0 font-normal"
          />
        ) : (
          <span className="truncate">{lines[0] ?? "Thought"}</span>
        )}
        <Chevron open={open} />
      </button>
      <AgentDisclosure id={contentId} open={open}>
        <div className="mt-0.5 ml-1.5 border-l border-border pl-3 text-muted-foreground">
          {children}
        </div>
      </AgentDisclosure>
    </div>
  );
}
