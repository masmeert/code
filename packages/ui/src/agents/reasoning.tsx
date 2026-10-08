import { useId, type ReactNode } from "react";
import { AgentDisclosure } from "@apcode/ui/agents/agent-disclosure";
import { ReasoningText } from "@apcode/ui/agents/loading-states/reasoning-text";
import { Chevron, useRevealOpen, type ToolReveal } from "@apcode/ui/agents/tool-group";

const THOUGHT_TITLES = [
  "Schlepped",
  "Combobulated",
  "Channelled",
  "Vibed",
  "Concocted",
  "Spelunked",
  "Transmuted",
  "Imagined",
  "Pontificated",
  "Whirred",
  "Cogitated",
  "Honked",
  "Noodled",
  "Percolated",
  "Ruminated",
  "Simmered",
  "Marinated",
  "Fermented",
  "Hatched",
  "Brewed",
  "Steeped",
  "Contemplated",
  "Mused",
  "Pondered",
  "Mulled it over",
  "Daydreamed",
  "Woolgathered",
  "Dithered",
  "Faffed about",
  "Tinkered",
  "Fiddled",
  "Finagled",
  "Wrangled",
  "Galumphed",
  "Meandered",
  "Moseyed",
  "Sauntered",
  "Caffeinated",
  "Had a little think",
  "Stroked chin thoughtfully",
  "Squinted at the problem",
  "Stared into the abyss",
  "Consulted the void",
  "Asked the electrons",
  "Bribed the compiler",
  "Negotiated with entropy",
  "Whispered to the bits",
  "Herded pointers",
  "Untangled spaghetti",
  "Consulted the rubber duck",
  "Shook the magic 8-ball",
  "Reticulated splines",
  "Reversed the polarity",
  "Consulted the oracle",
  "Divined the answer",
  "Scried the codebase",
  "Summoned semicolons",
  "Warmed up the hamsters",
  "Sweet-talked the API",
  "Gave the code a pep talk",
  "Greased the gears",
  "Baked at 350 kilobytes",
  "Sprinkled some magic dust",
];

/** A finished thought's title, the same every time for the same `id`. */
export function thoughtTitle(id: string) {
  return THOUGHT_TITLES[
    [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % THOUGHT_TITLES.length
  ]!;
}

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
