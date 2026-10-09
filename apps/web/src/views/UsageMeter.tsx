import { MorphPopover, MorphPopoverContent } from "@masscode/ui/motion/popover-morph";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand, type ContextUsage, type ProviderKind } from "@masscode/contracts";
import { ChevronRight, LoaderCircle, Minimize2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatKeybinding, useKeybinding } from "../lib/keybindings.ts";
import {
  readLimits,
  readUsage,
  send,
  useProviders,
  useStore,
  useThreadHost,
} from "../lib/store.ts";
import { useNow } from "../lib/time.ts";

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Keyed by the category's name so a row keeps its colour whatever else is in the window. */
const CATEGORY_COLOR = new Map([
  ["Messages", "bg-[#2a78d6] dark:bg-[#3987e5]"],
  ["System tools", "bg-[#eb6834] dark:bg-[#d95926]"],
  ["MCP tools", "bg-[#1baf7a] dark:bg-[#199e70]"],
  ["Skills", "bg-[#eda100] dark:bg-[#c98500]"],
  ["System prompt", "bg-[#e87ba4] dark:bg-[#d55181]"],
  ["Memory files", "bg-[#008300]"],
  ["Custom agents", "bg-[#4a3aa7] dark:bg-[#9085e9]"],
]);

function getCategoryColor(category: ContextUsage["categories"][number]) {
  if (category.kind === "free") return "bg-muted";
  if (category.kind !== "used") return "bg-muted-foreground/40";
  return CATEGORY_COLOR.get(category.name) ?? "bg-muted-foreground";
}

function getPercent(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** "Resets in 3 hr 21 min" within a day, else the weekday and time. */
export function formatResetLabel(resetsAt: number, now: number) {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes >= 24 * 60) {
    return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(resetsAt)}`;
  }

  const hours = Math.floor(minutes / 60);
  return `Resets in ${hours ? `${hours} hr ` : ""}${minutes % 60} min`;
}

/** Context fill of the thread as a ring in the composer; opens its breakdown, cost and the plan's limits. */
export function UsageMeter({
  threadId,
  provider,
  busy,
}: {
  threadId: string;
  provider: ProviderKind;
  busy: boolean;
}) {
  const usage = useStore((state) => state.threads[threadId]?.usage);
  const isReading = useStore((state) => state.readingUsage[threadId] ?? false);
  const host = useThreadHost(threadId);
  const [isOpen, setIsOpen] = useState(false);
  const isMissing = usage === undefined;

  useEffect(() => {
    if (isMissing) readUsage(threadId);
  }, [isMissing, threadId]);

  useKeybinding("usage.toggle", () => setIsOpen((wasOpen) => !wasOpen));

  useEffect(() => {
    if (isOpen) readLimits(provider, host);
  }, [isOpen, provider, host]);

  const context = usage?.context ?? null;
  const percent = context ? getPercent(context.usedTokens, context.maxTokens) : 0;
  const circumference = 2 * Math.PI * 6;

  return (
    <MorphPopover open={isOpen} onOpenChange={setIsOpen}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title={`${context ? `Context ${percent}% full` : "Context and usage"} (${formatKeybinding("usage.toggle")})`}
        aria-label={context ? `Context ${percent}% full` : "Context and usage"}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs text-muted-foreground tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring @max-md:w-8 @max-md:justify-center @max-md:px-0",
          percent >= 90 && "text-destructive hover:text-destructive",
        )}
      >
        {isReading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        <svg
          viewBox="0 0 16 16"
          className={cn("size-3.5 -rotate-90", isReading && "hidden")}
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.min(percent, 100) / 100)}
            className={cn("stroke-current", percent === 0 && "opacity-0")}
          />
        </svg>
        {context ? <span className="@max-md:hidden">{percent}%</span> : null}
      </button>
      <MorphPopoverContent side="top" align="end" sideOffset={6} radius={12} className="w-80 p-3">
        <ContextSection
          threadId={threadId}
          context={context}
          costUsd={usage?.costUsd ?? null}
          isReading={isReading}
          busy={busy}
        />
        <LimitsSection provider={provider} host={host} />
      </MorphPopoverContent>
    </MorphPopover>
  );
}

function ContextSection({
  threadId,
  context,
  costUsd,
  isReading,
  busy,
}: {
  threadId: string;
  context: ContextUsage | null;
  costUsd: number | null;
  isReading: boolean;
  busy: boolean;
}) {
  if (!context) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {isReading ? (
          <>
            <LoaderCircle className="size-3.5 animate-spin" />
            Reading context usage…
          </>
        ) : (
          "Context usage shows here once the agent has replied."
        )}
      </p>
    );
  }

  // Harnesses that don't break the window down (Codex) get one "used" row.
  const categories = context.categories.length
    ? context.categories.filter((category) => category.tokens > 0)
    : [{ name: "Used", tokens: context.usedTokens, kind: "used" as const }];

  return (
    <div className="text-xs">
      <details className="group">
        <summary className="-m-1 cursor-pointer list-none rounded-md p-1 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Context window</span>
            <span className="flex items-center gap-1 tabular-nums">
              {tokens.format(context.usedTokens)} / {tokens.format(context.maxTokens)} (
              {getPercent(context.usedTokens, context.maxTokens)}%)
              <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            </span>
          </div>
          <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
            {categories
              .filter((category) => category.kind === "used" || category.kind === "buffer")
              .map((category) => (
                <div
                  key={category.name}
                  title={`${category.name}: ${tokens.format(category.tokens)}`}
                  className={cn("h-full", getCategoryColor(category))}
                  style={{ width: `${(category.tokens / context.maxTokens) * 100}%` }}
                />
              ))}
          </div>
        </summary>
        <ul className="mt-2.5 space-y-1">
          {categories.map((category) => (
            <li
              key={category.name}
              className={cn(
                "flex items-center gap-2",
                category.kind === "deferred" && "text-muted-foreground",
              )}
            >
              <span className={cn("size-2 shrink-0 rounded-sm", getCategoryColor(category))} />
              <span className="min-w-0 flex-1 truncate">{category.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {tokens.format(category.tokens)}
              </span>
              <span className="w-10 text-right tabular-nums">
                {category.kind === "deferred"
                  ? "—"
                  : `${getPercent(category.tokens, context.maxTokens)}%`}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        {costUsd === null ? (
          <span />
        ) : (
          <span
            title="What this thread's tokens would cost at API list prices"
            className="text-muted-foreground tabular-nums"
          >
            {costUsd.toLocaleString("en", { style: "currency", currency: "USD" })} at API prices
          </span>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => send(ClientCommand.cases["thread.compact"].make({ threadId }))}
          title="Summarize the conversation so far to free up context"
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          <Minimize2 className="size-3.5" />
          Compact
        </button>
      </div>
    </div>
  );
}

function LimitsSection({ provider, host }: { provider: ProviderKind; host: string | null }) {
  const limits = useStore((state) =>
    host === null ? state.limits[provider] : state.hosts[host]?.limits[provider],
  );
  const plan = useProviders(host).find((status) => status.kind === provider)?.plan;
  const now = useNow(60_000);

  return (
    <div className="mt-3 border-t border-border pt-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">
          Usage limits{plan ? ` (${plan.charAt(0).toUpperCase()}${plan.slice(1)})` : ""}
        </span>
        <button
          type="button"
          onClick={() => readLimits(provider, host)}
          disabled={limits?.loading}
          title="Refresh"
          aria-label="Refresh usage limits"
          className="grid size-5 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        >
          {limits?.loading ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
      </div>
      {limits?.error ? <p className="mt-2 text-destructive">{limits.error}</p> : null}
      {limits && !limits.loading && !limits.error && !limits.limits.length ? (
        <p className="mt-2 text-muted-foreground">
          This login has no plan limits; API keys are billed per token instead.
        </p>
      ) : null}
      <ul className="mt-2 space-y-2.5">
        {limits?.limits.map((limit) => (
          <li key={limit.label}>
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{limit.label}</span>
              {limit.resetsAt === null ? null : (
                <span className="text-muted-foreground">
                  {formatResetLabel(limit.resetsAt, now)}
                </span>
              )}
              <span className="w-9 text-right tabular-nums">{Math.round(limit.usedPercent)}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  limit.usedPercent >= 90 ? "bg-destructive" : "bg-[#2a78d6] dark:bg-[#3987e5]",
                )}
                style={{ width: `${Math.min(limit.usedPercent, 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
