import { Check, Copy, Play } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AgentCodeLine, useAgentCodeTokens } from "@masscode/ui/agents/agent-code";
import { ActionSwapRollIcon } from "@masscode/ui/motion/action-swap-roll";
import { SPRING_PRESS } from "@masscode/ui/lib/ease";
import { cn } from "@masscode/ui/lib/utils";

export interface CommandBlockProps {
  command: string;
  /** While true, the command is still being written: it can be copied but not run yet. */
  streaming?: boolean;
  onRun: () => void;
  className?: string;
}

/** A shell command the agent suggests, with Run and Copy beside it instead of a code block's header. */
export function CommandBlock({ command, streaming = false, onRun, className }: CommandBlockProps) {
  const reduce = useReducedMotion() ?? false;
  const tokens = useAgentCodeTokens(command, "bash", streaming);
  const copyTimer = useRef<number | undefined>(undefined);
  const runTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [ran, setRan] = useState(false);
  let offset = 0;
  const lines = command.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
      window.clearTimeout(runTimer.current);
    },
    [],
  );

  async function copy() {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  function run() {
    // A double click would otherwise start the command twice.
    if (runTimer.current !== undefined) return;
    onRun();
    setRan(true);
    runTimer.current = window.setTimeout(() => {
      runTimer.current = undefined;
      setRan(false);
    }, 1600);
  }

  return (
    <div
      aria-busy={streaming}
      className={cn("flex items-start gap-2 rounded-xl bg-muted/80 py-1.5 pr-1.5 pl-4", className)}
    >
      <pre className="m-0 scrollbar-hide min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs leading-5 text-foreground/85">
        <code>
          {lines.map((line, index) => (
            <AgentCodeLine
              key={line.offset}
              code={line.content}
              tokens={tokens?.[index]}
              className="block min-h-5 whitespace-pre"
            />
          ))}
        </code>
      </pre>
      <div className="flex shrink-0 items-center">
        <motion.button
          type="button"
          disabled={streaming}
          aria-label={ran ? "Started" : "Run this command"}
          title={ran ? "Started" : "Run this command; the agent gets its output"}
          onClick={run}
          whileTap={reduce || streaming ? undefined : { scale: 0.95 }}
          transition={SPRING_PRESS}
          className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          <ActionSwapRollIcon value={ran ? "ran" : "run"} className="size-3.5">
            {ran ? <Check className="size-3.5" /> : <Play className="size-3.5" />}
          </ActionSwapRollIcon>
        </motion.button>
        <motion.button
          type="button"
          aria-label={copied ? "Copied" : "Copy command"}
          title={copied ? "Copied" : "Copy command"}
          onClick={copy}
          whileTap={reduce ? undefined : { scale: 0.95 }}
          transition={SPRING_PRESS}
          className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
        >
          <ActionSwapRollIcon value={copied ? "copied" : "copy"} className="size-3.5">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </ActionSwapRollIcon>
        </motion.button>
      </div>
    </div>
  );
}
