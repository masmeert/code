import {
  IconBan,
  IconBraces,
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconLoader2,
  IconRotate,
  IconTerminal2,
  IconTool,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AgentCode, type AgentCodeLanguage } from "@masscode/ui/agents/agent-code";
import { ActionSwapRollIcon, ActionSwapRollText } from "@masscode/ui/motion/action-swap-roll";
import { AgentDisclosure } from "@masscode/ui/agents/agent-disclosure";
import { spring } from "@masmeert/ui/lib/springs";
import { cn } from "@masscode/ui/lib/utils";
import { typeClass } from "@masmeert/ui/lib/type-scale";

export type ToolResultStatus = "running" | "success" | "error" | "cancelled";
export type ToolResultKind = "terminal" | "request" | "custom";

export interface ToolResultProps {
  tool: ReactNode;
  title: ReactNode;
  children: ReactNode;
  status?: ToolResultStatus;
  kind?: ToolResultKind;
  meta?: ReactNode;
  icon?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  copyText?: string;
  onCopy?: () => void | Promise<void>;
  onRetry?: () => void;
  className?: string;
  contentClassName?: string;
}

export interface ToolResultOutputProps {
  children: string;
  language?: AgentCodeLanguage;
  className?: string;
}

function getStatusLabel(status: ToolResultStatus) {
  if (status === "running") return "Running";
  if (status === "success") return "Completed";
  if (status === "error") return "Failed";
  return "Cancelled";
}

function getStatusClass(status: ToolResultStatus) {
  if (status === "running") {
    return "text-success";
  }
  if (status === "success") {
    return "text-success";
  }
  if (status === "error") {
    return "text-destructive";
  }
  return "text-muted-foreground";
}

function KindIcon({ kind }: { kind: ToolResultKind }) {
  if (kind === "terminal") return <IconTerminal2 className="size-4" />;
  if (kind === "request") return <IconBraces className="size-4" />;
  return <IconTool className="size-4" />;
}

function StatusIcon({ status, reduce }: { status: ToolResultStatus; reduce: boolean }) {
  if (status === "running") {
    return <IconLoader2 className={cn("size-3", !reduce && "animate-spin")} />;
  }
  if (status === "success") return <IconCircleCheck className="size-3" />;
  if (status === "error") return <IconCircleX className="size-3" />;
  return <IconBan className="size-3" />;
}

function ToolResultAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      whileTap={reduce ? undefined : { scale: 0.95 }}
      transition={spring.fast}
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
    >
      {children}
    </motion.button>
  );
}

export function ToolResultOutput({
  children,
  language = "bash",
  className,
}: ToolResultOutputProps) {
  return (
    <AgentCode
      code={children}
      language={language}
      className={cn("break-words whitespace-pre-wrap text-foreground", className)}
    />
  );
}

export function ToolResult({
  tool,
  title,
  children,
  status = "running",
  kind = "custom",
  meta,
  icon,
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 220,
  copyText,
  onCopy,
  onRetry,
  className,
  contentClassName,
}: ToolResultProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const running = status === "running";
  const canCopy = Boolean(copyText || onCopy);
  const statusLabel = getStatusLabel(status);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousStatus.current !== "running" && status === "running") {
      setOpen(true);
    }
    if (previousStatus.current === "running" && status !== "running" && collapseOnComplete) {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !currentOpen || !running) return;

    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else if (copyText) await navigator.clipboard?.writeText(copyText);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={running}
      className={cn(typeClass("body"), "w-full", className)}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center text-muted-foreground"
        >
          {icon ?? <KindIcon kind={kind} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
          {meta ? (
            <span className={cn(typeClass("caption"), "shrink-0 text-muted-foreground")}>
              {meta}
            </span>
          ) : null}
          <span
            className={cn(
              typeClass("caption", "compact"),
              "min-w-0 truncate font-mono text-muted-foreground",
            )}
          >
            {tool}
          </span>
        </span>
        <span
          className={cn(
            typeClass("caption", "compact"),
            "inline-flex shrink-0 items-center gap-1 font-medium",
            getStatusClass(status),
          )}
        >
          <StatusIcon status={status} reduce={reduce} />
          <ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
        </span>
        <IconChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition duration-(--duration-moderate) ease-out group-hover:text-muted-foreground",
            currentOpen && "rotate-90",
          )}
        />
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <div className="pt-1.5 pl-6">
          <div className="overflow-hidden rounded-xl bg-muted/80">
            <div
              ref={viewportRef}
              role="log"
              aria-live="polite"
              className="scrollbar-hide overflow-y-auto"
              style={{ maxHeight }}
            >
              <div className={cn("p-3", contentClassName)}>{children}</div>
            </div>

            {canCopy || onRetry ? (
              <div className="flex items-center gap-0.5 px-2 pb-1.5">
                {canCopy ? (
                  <ToolResultAction label={copied ? "Copied" : "Copy result"} onClick={handleCopy}>
                    <ActionSwapRollIcon value={copied ? "copied" : "copy"} className="size-3.5">
                      {copied ? (
                        <IconCheck className="size-3.5" />
                      ) : (
                        <IconCopy className="size-3.5" />
                      )}
                    </ActionSwapRollIcon>
                  </ToolResultAction>
                ) : null}
                {onRetry ? (
                  <ToolResultAction label="Run again" onClick={onRetry}>
                    <IconRotate className="size-3.5" />
                  </ToolResultAction>
                ) : null}
                <span
                  className={cn(typeClass("caption", "compact"), "ml-auto text-muted-foreground")}
                >
                  {statusLabel}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </AgentDisclosure>
    </div>
  );
}
