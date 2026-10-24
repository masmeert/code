import { IconCheck, IconCopy, IconFileCode, IconLoader2 } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@masscode/ui/agents/agent-code";
import { ActionSwapRollIcon } from "@masscode/ui/motion/action-swap-roll";
import { spring } from "@masmeert/ui/lib/springs";
import { cn } from "@masscode/ui/lib/utils";
import { typeClass } from "@masmeert/ui/lib/type-scale";

export type CodeBlockStatus = "streaming" | "complete";

export interface CodeBlockProps {
  code: string;
  language?: AgentCodeLanguage;
  filename?: ReactNode;
  status?: CodeBlockStatus;
  /** Shows the Writing / Ready badge in the header. */
  showStatus?: boolean;
  showLineNumbers?: boolean;
  highlightLines?: number[];
  maxHeight?: number;
  wrap?: boolean;
  copyable?: boolean;
  onCopy?: () => void | Promise<void>;
  className?: string;
}

export function CodeBlock({
  code,
  language = "typescript",
  filename,
  status = "complete",
  showStatus = true,
  showLineNumbers = true,
  highlightLines = [],
  maxHeight = 280,
  wrap = false,
  copyable = true,
  onCopy,
  className,
}: CodeBlockProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const streaming = status === "streaming";
  const tokens = useAgentCodeTokens(code, language, streaming);
  const highlighted = useMemo(() => new Set(highlightLines), [highlightLines]);
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !streaming) return;

    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else await navigator.clipboard?.writeText(code);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [code, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn(typeClass("body"), "w-full overflow-hidden rounded-2xl bg-muted/80", className)}
    >
      <div className="flex h-10 items-center gap-2.5 px-3">
        <IconFileCode aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {filename ? (
          <span className={cn(typeClass("caption"), "min-w-0 truncate font-mono text-foreground")}>
            {filename}
          </span>
        ) : null}
        <span className={cn(typeClass("micro"), "font-medium text-muted-foreground")}>
          {language}
        </span>
        <span className="ml-auto" />
        {showStatus ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-success">
            {streaming ? (
              <IconLoader2 className={cn("size-3", !reduce && "animate-spin")} />
            ) : (
              <IconCheck className="size-3" />
            )}
            {streaming ? "Writing" : "Ready"}
          </span>
        ) : null}
        {copyable || onCopy ? (
          <motion.button
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code"}
            onClick={handleCopy}
            whileTap={reduce ? undefined : { scale: 0.95 }}
            transition={spring.fast}
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
          >
            <ActionSwapRollIcon value={copied ? "copied" : "copy"} className="size-3.5">
              {copied ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
            </ActionSwapRollIcon>
          </motion.button>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        role={streaming ? "log" : undefined}
        aria-live={streaming ? "polite" : undefined}
        className="scrollbar-hide overflow-auto border-t border-foreground/[0.06] py-2"
        style={{ maxHeight }}
      >
        <pre
          className={cn(typeClass("caption"), "m-0 min-w-max font-mono leading-5 text-foreground")}
        >
          <code>
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              return (
                <span
                  key={line.offset}
                  className={cn(
                    "grid min-h-5",
                    showLineNumbers ? "grid-cols-[2.75rem_minmax(0,1fr)]" : "grid-cols-1",
                    highlighted.has(lineNumber) && "bg-brand/10",
                  )}
                >
                  {showLineNumbers ? (
                    <span className="pr-3 text-right text-muted-foreground tabular-nums select-none">
                      {lineNumber}
                    </span>
                  ) : null}
                  <AgentCodeLine
                    code={line.content}
                    tokens={tokens?.[index]}
                    className={cn(
                      "pr-4",
                      showLineNumbers ? "pl-1" : "pl-4",
                      wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
                    )}
                  />
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
