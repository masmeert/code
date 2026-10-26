import { ResizeHandle } from "@masmeert/ui/resize-handle";
import { useResizable } from "@masmeert/ui/hooks/use-resizable";
import { cn } from "@masscode/ui/lib/utils";
import { Input } from "@masmeert/ui/input";
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconPlus,
  IconRotateClockwise,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@/shared/ui";
import {
  type BrowserTab,
  clearSurface,
  closeTab,
  goBack,
  goForward,
  navigate,
  openTab,
  registerAddressInput,
  reload,
  selectTab,
  setSurface,
  showTab,
  stop,
  type TabActivity,
  toggleBrowser,
  updateActivity,
  useBrowser,
} from "@/entities/browser";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { closeOnEscape } from "../lib/close-on-escape.ts";
import { PanelAction, PanelMessage } from "./panel-message.tsx";

function getUrlHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function BrowserPanel({ threadId }: { threadId: string }) {
  const browser = useBrowser((state) => state.threads[threadId]);
  const tab = browser?.tabs.find((candidate) => candidate.id === browser.activeTabId);
  const activity = useBrowser((state) => (tab ? state.activity[tab.id] : undefined));

  const aside = useRef<HTMLElement>(null);

  const panel = useResizable({
    key: "masscode.browserPanelWidth",
    initial: Math.min(720, Math.round(window.innerWidth * 0.4)),
    side: "start",
    clamp: (width) =>
      Math.max(
        320,
        Math.min(width, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - 380),
      ),
  });

  useEffect(() => {
    if (tab?.url) showTab(threadId, tab.id);
  }, [threadId, tab?.id, tab?.url]);

  return (
    <aside
      ref={aside}
      aria-label="Browser"
      style={{ width: panel.width }}
      onKeyDown={closeOnEscape(() => toggleBrowser(threadId))}
      className="relative flex min-h-0 max-w-[max(calc(100%_-_380px),50%)] min-w-[min(320px,50%)] shrink flex-col border-l border-border bg-background"
    >
      <ResizeHandle
        side="start"
        label="Resize browser"
        value={panel.width}
        dragging={panel.dragging}
        {...panel.handleProps}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <div
          role="tablist"
          aria-label="Browser tabs"
          className="scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {browser?.tabs.map((candidate) => (
            <TabButton
              key={candidate.id}
              threadId={threadId}
              tab={candidate}
              isActive={candidate.id === tab?.id}
            />
          ))}
        </div>
        <IconButton label="New tab" onClick={() => openTab(threadId)}>
          <IconPlus className="size-4" />
        </IconButton>
        <IconButton
          label="Hide browser (Esc)"
          className="ml-auto"
          onClick={() => toggleBrowser(threadId)}
        >
          <IconX className="size-4" />
        </IconButton>
      </div>
      {tab ? <AddressBar key={tab.id} threadId={threadId} tab={tab} activity={activity} /> : null}
      {!tab?.url ? (
        <PanelMessage>Enter an address to open a page.</PanelMessage>
      ) : activity?.error ? (
        <PanelMessage>
          <span className="selectable text-foreground">{activity.error}</span>
          <PanelAction onClick={() => reload(tab.id)}>Try again</PanelAction>
        </PanelMessage>
      ) : (
        <BrowserSurface threadId={threadId} />
      )}
    </aside>
  );
}

function TabButton({
  threadId,
  tab,
  isActive,
}: {
  threadId: string;
  tab: BrowserTab;
  isActive: boolean;
}) {
  const favicon = useBrowser((state) => state.activity[tab.id]?.favicon ?? null);
  const label = tab.title || getUrlHost(tab.url) || "New tab";

  return (
    <div
      className={cn(
        typeClass("caption"),
        "group/tab flex h-7 max-w-44 shrink-0 items-center rounded-lg pr-0.5 transition-colors",
        isActive
          ? "bg-selected text-foreground"
          : "text-muted-foreground hover:bg-hover hover:text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        title={tab.url || label}
        onClick={() => selectTab(threadId, tab.id)}
        className="flex h-full min-w-0 items-center gap-1.5 rounded-lg pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {favicon ? (
          <img
            src={favicon}
            alt=""
            onError={() => updateActivity(tab.id, { favicon: null })}
            className="size-3.5 shrink-0 rounded-sm"
          />
        ) : (
          <IconWorld className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        title="Close tab"
        aria-label={`Close ${label}`}
        onClick={() => closeTab(threadId, tab.id)}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md transition-opacity outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
          isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <IconX className="size-3" />
      </button>
    </div>
  );
}

function AddressBar({
  threadId,
  tab,
  activity,
}: {
  threadId: string;
  tab: BrowserTab;
  activity: TabActivity | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(tab.url);
  const [isEditing, setIsEditing] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);

  useEffect(() => {
    if (!isEditing) setDraft(tab.url);
  }, [tab.url, isEditing]);

  useEffect(() => registerAddressInput(threadId, input.current!), [threadId]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();

        if (!navigate(threadId, tab.id, draft)) return setIsInvalid(true);
        setIsInvalid(false);
        input.current?.blur();
      }}
      className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-2"
    >
      <IconButton label="Back" disabled={!activity?.canGoBack} onClick={() => goBack(tab.id)}>
        <IconArrowLeft className="size-4" />
      </IconButton>
      <IconButton
        label="Forward"
        disabled={!activity?.canGoForward}
        onClick={() => goForward(tab.id)}
      >
        <IconArrowRight className="size-4" />
      </IconButton>
      {activity?.loading ? (
        <IconButton label="Stop" onClick={() => stop(tab.id)}>
          <IconX className="size-4" />
        </IconButton>
      ) : (
        <IconButton label="Reload" disabled={!tab.url} onClick={() => reload(tab.id)}>
          <IconRotateClockwise className="size-4" />
        </IconButton>
      )}
      {activity?.automating ? (
        <span
          className={cn(
            typeClass("caption", "compact"),
            "ml-1 shrink-0 rounded-md bg-brand/15 px-1.5 py-0.5 font-medium text-brand",
          )}
        >
          Agent
        </span>
      ) : null}
      <Input
        ref={input}
        autoFocus={!tab.url}
        value={draft}
        onChange={(value) => {
          setDraft(value);
          setIsInvalid(false);
        }}
        onFocus={(event) => {
          setIsEditing(true);
          event.currentTarget.select();
        }}
        onBlur={() => setIsEditing(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setDraft(tab.url);
          event.currentTarget.blur();
        }}
        error={isInvalid}
        placeholder="Enter address"
        aria-label="Address"
        spellCheck={false}
        className="mx-1 min-w-0 flex-1"
        classNames={{
          field:
            "h-7 rounded-lg border-transparent bg-muted/60 ring-0 data-[state=focused]:bg-muted",
          input: cn(
            typeClass("caption"),
            "selectable px-2.5 font-mono placeholder:text-muted-foreground",
          ),
        }}
      />
      <IconButton
        label="Open in default browser"
        disabled={!tab.url}
        onClick={() => window.open(tab.url, "_blank")}
      >
        <IconExternalLink className="size-4" />
      </IconButton>
    </form>
  );
}

function BrowserSurface({ threadId }: { threadId: string }) {
  const slot = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = slot.current!;

    function publishSurface() {
      const rect = element.getBoundingClientRect();
      setSurface(threadId, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }

    publishSurface();
    const observer = new ResizeObserver(publishSurface);
    observer.observe(element);
    window.addEventListener("resize", publishSurface);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishSurface);
      clearSurface(threadId);
    };
  }, [threadId]);

  return <div ref={slot} className="min-h-0 flex-1" />;
}
