import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverMenu,
} from "@apcode/ui/motion/popover-morph";
import { cn } from "@apcode/ui/lib/utils";
import { ClientCommand, type GitAction } from "@apcode/contracts";
import { ArrowUp, ChevronDown, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { send, useStore } from "../lib/store.ts";

type Panel = "menu" | "commit" | null;

const PENDING_LABEL: Record<GitAction, string> = {
  commit: "Committing…",
  "commit-push": "Committing…",
  push: "Pushing…",
};

const MenuItem = ({
  onClick,
  disabled,
  children,
  hint,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  hint?: ReactNode;
}) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:text-muted-foreground"
  >
    {children}
    {hint ? (
      <span className="ml-auto pl-3 font-mono text-xs text-muted-foreground tabular-nums">
        {hint}
      </span>
    ) : null}
  </button>
);

/**
 * Commit / push for the thread's folder: the main button commits every change (or pushes
 * when there's nothing to commit), the chevron opens the rest. `refreshKey` changes whenever
 * the thread may have touched files, which re-reads the repo state.
 */
export const GitMenu = ({ cwd, refreshKey }: { cwd: string; refreshKey: string }) => {
  const repo = useStore((s) => s.repos[cwd]);
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<GitAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => send(ClientCommand.cases["git.status"].make({ path: cwd })),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [cwd, refreshKey]);

  // Any update carrying an action answers the one in flight (only one runs per repo at a time).
  const answerPending = useEffectEvent(() => {
    if (!repo?.action || !pending) return;
    setPending(null);
    setError(repo.error);
    if (!repo.error) {
      if (repo.action !== "push") setMessage("");
      setPanel(null);
    } else if (repo.status?.changes === 0) {
      // The commit landed even though the push after it failed.
      setMessage("");
    }
  });
  useEffect(() => answerPending(), [repo]);

  useEffect(() => {
    if (panel === "commit") requestAnimationFrame(() => textarea.current?.focus());
    if (panel) send(ClientCommand.cases["git.status"].make({ path: cwd }));
  }, [panel, cwd]);

  const status = repo?.status;
  if (!repo || !status) return null;

  const canCommit = status.changes > 0 && !pending;
  const canPush = status.hasRemote && !status.detached && status.ahead > 0 && !pending;
  const pushHint = status.upstream ? `↑${status.ahead}` : status.ahead ? "new branch" : undefined;
  const run = (action: GitAction) => {
    setError(null);
    setPending(action);
    if (action === "push") send(ClientCommand.cases["git.push"].make({ path: cwd }));
    else
      send(
        ClientCommand.cases["git.commit"].make({
          path: cwd,
          message,
          push: action === "commit-push",
        }),
      );
  };
  // With nothing to commit, the main button pushes instead.
  const primaryPushes = status.changes === 0 && canPush;
  const primary = () =>
    primaryPushes ? run("push") : setPanel(panel === "commit" ? null : "commit");
  // An empty message is written by the commit model first, which takes a moment.
  const pendingLabel =
    pending && pending !== "push" && !message.trim()
      ? "Writing message…"
      : pending
        ? PENDING_LABEL[pending]
        : null;
  const errorNote = error ? (
    <p className="px-2 pt-1.5 pb-1 text-xs whitespace-pre-wrap text-destructive">{error}</p>
  ) : null;

  return (
    <MorphPopover open={panel !== null} onOpenChange={(open) => !open && setPanel(null)}>
      <div className="flex h-7 items-stretch overflow-hidden rounded-lg border border-border text-muted-foreground">
        <button
          type="button"
          onClick={primary}
          disabled={!!pending || (!canCommit && !primaryPushes)}
          title={
            primaryPushes
              ? "Push commits"
              : status.changes
                ? `Commit ${status.changes} changed ${status.changes === 1 ? "file" : "files"}`
                : "Nothing to commit"
          }
          className="flex items-center gap-1.5 pr-2.5 pl-2 text-xs font-medium transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 disabled:pointer-events-none disabled:opacity-50"
        >
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : primaryPushes ? (
            <ArrowUp className="size-4" />
          ) : (
            <GitCommitHorizontal className="size-4" />
          )}
          {pending ? pendingLabel : primaryPushes ? "Push" : "Commit"}
          {!pending && primaryPushes && status.upstream ? (
            <span className="font-mono tabular-nums opacity-70">{status.ahead}</span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label="Git actions"
          aria-haspopup="menu"
          aria-expanded={panel === "menu"}
          onClick={() => setPanel(panel === "menu" ? null : "menu")}
          className={cn(
            "grid w-6 place-items-center border-l border-border transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60",
            panel === "menu" && "bg-muted/60 text-foreground",
          )}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      <MorphPopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        radius={12}
        className={panel === "commit" ? "w-80 p-2" : "w-56 p-1.5"}
      >
        {panel === "commit" ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (canCommit) run("commit");
            }}
          >
            <textarea
              ref={textarea}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
                  e.preventDefault();
                  run(e.shiftKey && status.hasRemote ? "commit-push" : "commit");
                }
              }}
              placeholder="Commit message, or leave empty to generate one"
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="px-0.5 text-xs text-muted-foreground">
              {status.changes} changed {status.changes === 1 ? "file" : "files"}, all staged on
              commit
            </p>
            {errorNote}
            <div className="flex justify-end gap-1.5">
              {status.hasRemote && !status.detached ? (
                <button
                  type="button"
                  title="⌘⇧↩"
                  disabled={!canCommit}
                  onClick={() => run("commit-push")}
                  className="h-7 rounded-lg border border-border px-2.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Commit & push
                </button>
              ) : null}
              <button
                type="submit"
                title="⌘↩"
                disabled={!canCommit}
                className="h-7 rounded-lg bg-foreground px-2.5 text-xs font-medium text-background transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {pending && pending !== "push" ? pendingLabel : "Commit"}
              </button>
            </div>
          </form>
        ) : (
          <MorphPopoverMenu>
            <MenuItem
              onClick={() => setPanel("commit")}
              disabled={!canCommit}
              hint={status.changes || undefined}
            >
              <GitCommitHorizontal />
              Commit…
            </MenuItem>
            <MenuItem
              onClick={() => run("push")}
              disabled={!canPush}
              hint={canPush ? pushHint : undefined}
            >
              <ArrowUp />
              Push
            </MenuItem>
            {!status.hasRemote ? (
              <p className="px-2 pt-1 text-xs text-muted-foreground">No remote configured</p>
            ) : null}
            {status.behind > 0 ? (
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                {status.behind} {status.behind === 1 ? "commit" : "commits"} behind{" "}
                {status.upstream}
              </p>
            ) : null}
            {errorNote}
          </MorphPopoverMenu>
        )}
      </MorphPopoverContent>
    </MorphPopover>
  );
};
