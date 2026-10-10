import { useId, type ReactNode } from "react";
import { AgentDisclosure } from "@masscode/ui/agents/agent-disclosure";
import { ReasoningText } from "@masscode/ui/agents/loading-states/reasoning-text";
import { Chevron, useRevealOpen, type ToolReveal } from "@masscode/ui/agents/tool-group";

/**
 * The agent's thinking, folded to one line so a long think doesn't read as a stall: what it's doing
 * while it streams, `label` once done. The rest is only read on purpose: `children`, shown when opened.
 */
export function Reasoning({
  label,
  streaming,
  live,
  reveal = null,
  children,
}: {
  label: string;
  streaming: boolean;
  /** What it's doing right now, e.g. the running tool; short phrases cycle without one. */
  live?: string;
  /** Opens it, for a tool call folded inside. */
  reveal?: ToolReveal | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useRevealOpen(reveal);
  const contentId = useId();

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
            variant="scramble"
            // ReasoningText adds its own ellipsis.
            phrases={live ? [live.replace(/[.…:]+$/, "")] : undefined}
            className="min-w-0 font-mono font-normal"
          />
        ) : (
          <span className="truncate">{label}</span>
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
