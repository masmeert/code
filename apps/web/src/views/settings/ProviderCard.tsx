import { Button } from "@masscode/ui/motion/button/base";
import { Skeleton } from "@masscode/ui/components/skeleton";
import { getHarnessTint, PROVIDER_LOGO } from "@/components/provider-logo";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand, ProviderKind, type ProviderStatus } from "@masscode/contracts";
import * as Match from "effect/Match";
import { useState } from "react";
import { formatHarnessLabel } from "../../lib/models.ts";
import { send, useStore } from "../../lib/store.ts";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

/** CLIs report versions as e.g. "2.1.281 (Claude Code)" or "codex-cli 0.154.0"; keep just the number. */
function formatShortVersion(raw: string) {
  return raw.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? raw;
}

function formatStatusLine(status: ProviderStatus | undefined) {
  if (!status) return "Checking…";
  if (!status.installed) return status.error ?? "Not installed";
  return status.linked ? (status.account ?? "Signed in") : "Not signed in";
}

export function ProviderCard({
  kind,
  status,
  host = null,
}: {
  kind: ProviderKind;
  status: ProviderStatus | undefined;
  /** The remote host whose harness this is; this Mac's when left out. */
  host?: string | null;
}) {
  const settings = useStore((state) => state.settings);
  const flow = useStore((state) =>
    host === null ? state.authFlows[kind] : state.hosts[host]?.authFlows[kind],
  );
  const [isConfirmingUnlink, setIsConfirmingUnlink] = useState(false);
  const [code, setCode] = useState("");

  const isSigningIn =
    flow &&
    (flow.stage === "starting" || flow.stage === "browser" || flow.stage === "awaiting-code");
  const Logo = PROVIDER_LOGO[kind];
  const isChecking = !status || status.checking === true;

  function renderAction() {
    if (isChecking) return <Skeleton className="h-7 w-16 rounded-lg" />;
    if (!status?.installed) return null;

    if (isSigningIn)
      return (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg"
          onClick={() =>
            send(ClientCommand.cases["provider.linkCancel"].make({ provider: kind }), host)
          }
        >
          Cancel
        </Button>
      );

    if (status.linked && isConfirmingUnlink)
      return (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg"
            onClick={() => setIsConfirmingUnlink(false)}
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
            onClick={() => {
              setIsConfirmingUnlink(false);
              send(ClientCommand.cases["provider.unlink"].make({ provider: kind }), host);
            }}
          >
            Sign out
          </Button>
        </div>
      );

    if (status.linked)
      return (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 rounded-lg"
          onClick={() => setIsConfirmingUnlink(true)}
        >
          Unlink
        </Button>
      );

    if (host !== null && kind === "codex") return null;

    return (
      <Button
        size="sm"
        className="h-7 rounded-lg"
        onClick={() => send(ClientCommand.cases["provider.link"].make({ provider: kind }), host)}
      >
        Link
      </Button>
    );
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                getHarnessTint(settings, kind).avatar,
              )}
            >
              <Logo className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-medium">{formatHarnessLabel(settings, kind)}</span>
                {status?.version ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    v{formatShortVersion(status.version)}
                  </span>
                ) : null}
                {status?.linked && status.plan ? (
                  <span className="self-center rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground capitalize">
                    {status.plan}
                  </span>
                ) : null}
              </div>
              {isChecking ? (
                <Skeleton aria-label="Checking…" className="mt-1 h-3 w-36" />
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      status?.linked
                        ? "bg-success"
                        : status?.installed
                          ? "bg-warning"
                          : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate">{formatStatusLine(status)}</span>
                </div>
              )}
            </div>
          </div>
        }
      >
        {renderAction()}
      </SettingsRow>

      {isConfirmingUnlink ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          This signs {formatHarnessLabel(settings, kind)} out on {host ?? "this Mac"}, including in
          your terminal.
        </p>
      ) : null}

      {host !== null && kind === "codex" && status?.installed && !status.linked && !isChecking ? (
        // Codex's sign-in page calls back to a server on the host, which this Mac's browser can't reach.
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          To link it, run <code className="selectable font-mono">codex login --device-auth</code> in
          a terminal on {host}, for example one opened from a thread there.
        </p>
      ) : null}

      {isSigningIn ? (
        <div className="px-3 py-2.5 text-xs text-muted-foreground">
          {Match.value(flow.stage).pipe(
            Match.when("starting", () => "Starting sign-in…"),
            Match.when("browser", () => "Finish signing in in your browser."),
            Match.orElse(() => (
              <>
                <p className="mb-2">Sign in in your browser, then paste the code it shows.</p>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && code.trim())
                        send(
                          ClientCommand.cases["provider.linkCode"].make({
                            provider: kind,
                            code: code.trim(),
                          }),
                          host,
                        );
                    }}
                    placeholder="Paste code"
                    className="selectable h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                  <Button
                    size="sm"
                    className="h-7 rounded-lg"
                    disabled={!code.trim()}
                    onClick={() =>
                      send(
                        ClientCommand.cases["provider.linkCode"].make({
                          provider: kind,
                          code: code.trim(),
                        }),
                        host,
                      )
                    }
                  >
                    Submit
                  </Button>
                </div>
              </>
            )),
          )}
          {flow.url ? (
            <a
              href={flow.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block truncate underline"
            >
              Open sign-in page again
            </a>
          ) : null}
        </div>
      ) : flow?.stage === "failed" ? (
        <p className="px-3 py-2.5 text-xs text-destructive">{flow.message ?? "Sign-in failed"}</p>
      ) : null}
    </SettingsGroup>
  );
}
