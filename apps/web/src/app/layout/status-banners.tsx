import { Button } from "@masmeert/ui/button";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { useSidebar } from "@masmeert/ui/sidebar";
import { cn } from "@masscode/ui/lib/utils";
import { ClientCommand } from "@masscode/contracts";
import { IconAlertTriangle, IconArchive, IconPlugConnectedX } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { useHostStore } from "@/entities/host";
import { useThreadHost, useThreadStore } from "@/entities/thread";
import { reconnectNow, send } from "@/shared/api";
import { hasTrafficLights } from "@/shared/config";
import { openSettings } from "@/shared/lib/settings-route";
import { TextWithCode } from "@/shared/ui";

interface Banner {
  readonly key: string;
  readonly tone: "error" | "warning" | "neutral";
  readonly icon: ReactNode;
  readonly message: ReactNode;
  readonly actions?: ReactNode;
}

/**
 * Above the thread or draft, in the layout's flow so nothing under it is covered: why the
 * daemons can't be used, and whether the thread on screen is archived.
 */
export function StatusBanners({ threadId }: { threadId: string | null }) {
  const { open: isSidebarOpen } = useSidebar();
  const isLocalConnected = useHostStore((state) => state.connected);
  const localIncompatible = useHostStore((state) => state.incompatible);
  const source = useHostStore((state) => state.source);
  const hosts = useHostStore((state) => state.hosts);
  const threadHost = useThreadHost(threadId ?? "");

  const archivedAt = useThreadStore((state) =>
    threadId ? (state.threads[threadId]?.archivedAt ?? null) : null,
  );

  // A cold start takes a moment and the cached threads are already on screen, so
  // only speak up if it's slow. Losing a live daemon is worth saying right away.
  const [isSlowStart, setIsSlowStart] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setIsSlowStart(true), 2500);

    return () => clearTimeout(timer);
  }, []);

  // The host a Retry was just pressed for, so the button shows it's trying.
  const [retryingHost, setRetryingHost] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (retryingHost === undefined) return;

    const timer = setTimeout(() => setRetryingHost(undefined), 3000);

    return () => clearTimeout(timer);
  }, [retryingHost]);

  function renderRetry(host: string | null) {
    return (
      <Button
        size="compact"
        variant="secondary"
        disabled={retryingHost === host}
        onClick={() => {
          setRetryingHost(host);
          reconnectNow(host);
        }}
        className="h-6 rounded-lg px-2"
      >
        {retryingHost === host ? "Retrying…" : "Retry now"}
      </Button>
    );
  }

  const connectionsLink = window.desktop ? (
    <Button
      size="compact"
      variant="ghost"
      onClick={() => openSettings("connections")}
      className="h-6 rounded-lg px-2"
    >
      Open Connections
    </Button>
  ) : null;

  const banners: Array<Banner> = [];

  if (localIncompatible)
    banners.push({
      key: "local",
      tone: "error",
      icon: <IconAlertTriangle />,
      message: <TextWithCode text={localIncompatible} />,
    });
  else if (!isLocalConnected && (source === "daemon" || isSlowStart))
    banners.push({
      key: "local",
      tone: "warning",
      icon: <IconPlugConnectedX />,
      message:
        source === "daemon"
          ? "Lost the connection to MassCode's daemon. Reconnecting… Changes you make wait until it's back."
          : "Starting MassCode's daemon…",
      actions: renderRetry(null),
    });

  for (const [alias, host] of Object.entries(hosts)) {
    if (host.incompatible)
      banners.push({
        key: alias,
        tone: "error",
        icon: <IconAlertTriangle />,
        message: <TextWithCode text={host.incompatible} />,
        actions: connectionsLink,
      });
    // Other machines come and go; only the one this thread runs on is worth a banner.
    else if (alias === threadHost && !host.connected)
      banners.push({
        key: alias,
        tone: "warning",
        icon: <IconPlugConnectedX />,
        message: `${alias} isn't connected. Reconnecting… Messages you send wait until it's back.`,
        actions: (
          <>
            {renderRetry(alias)}
            {connectionsLink}
          </>
        ),
      });
  }

  if (threadId && archivedAt !== null)
    banners.push({
      key: "archived",
      tone: "neutral",
      icon: <IconArchive />,
      message: "This thread is archived. Sending a message unarchives it.",
      actions: (
        <Button
          size="compact"
          variant="secondary"
          onClick={() =>
            send(ClientCommand.cases["thread.archive"].make({ threadId, archived: false }))
          }
          className="h-6 rounded-lg px-2"
        >
          Unarchive
        </Button>
      ),
    });

  if (banners.length === 0) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 flex-col border-b border-border",
        // The traffic lights sit over the window's top-left corner while the sidebar is hidden.
        !isSidebarOpen && hasTrafficLights && "pl-[70px]",
      )}
    >
      {banners.map((banner) => (
        <div
          key={banner.key}
          className={cn(
            typeClass("caption"),
            "flex min-h-9 items-center gap-2 px-4 py-1.5 [-webkit-app-region:drag]",
            banner.tone === "error" && "bg-destructive/10 text-destructive",
            banner.tone === "warning" && "bg-warning/10 text-foreground",
            banner.tone === "neutral" && "bg-muted/60 text-muted-foreground",
          )}
        >
          <span aria-hidden="true" className="grid shrink-0 place-items-center [&>svg]:size-4">
            {banner.icon}
          </span>
          <p className="min-w-0 flex-1 selectable [-webkit-app-region:no-drag]">{banner.message}</p>
          {banner.actions ? (
            <span className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              {banner.actions}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
