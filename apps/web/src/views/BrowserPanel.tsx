import { ResizeHandle } from "@apcode/ui/components/resize-handle";
import { useResizable } from "@apcode/ui/hooks/use-resizable";
import { cn } from "@apcode/ui/lib/utils";
import { Input } from "@apcode/ui/motion/input";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../components/icon-button.tsx";
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
} from "../lib/browser.ts";

function hostOf(url: string) {
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
    key: "apcode.browserPanelWidth",
    initial: Math.min(720, Math.round(window.innerWidth * 0.4)),
    side: "start",
    clamp: (width) => Math.max(320, Math.min(width, (aside.current?.parentElement?.clientWidth ?? window.innerWidth) - 380)),
  });

  useEffect(() => {
    if (tab?.url) showTab(threadId, tab.id);
  }, [threadId, tab?.id, tab?.url]);

  return (
    <aside
      ref={aside}
      aria-label="Browser"
      style={{ width: panel.width }}
      className="relative flex min-h-0 min-w-80 shrink flex-col border-l border-border bg-background"
    >
      <ResizeHandle side="start" label="Resize browser" value={panel.width} dragging={panel.dragging} {...panel.handleProps} />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <div role="tablist" aria-label="Browser tabs" className="scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {browser?.tabs.map((candidate) => (
            <TabButton key={candidate.id} threadId={threadId} tab={candidate} active={candidate.id === tab?.id} />
          ))}
        </div>
        <IconButton label="New tab" onClick={() => openTab(threadId)}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton label="Hide browser" className="ml-auto" onClick={() => toggleBrowser(threadId)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {tab ? <AddressBar key={tab.id} threadId={threadId} tab={tab} activity={activity} /> : null}
      {!tab?.url ? (
        <Message>Enter an address to open a page.</Message>
      ) : activity?.error ? (
        <Message>
          <span>
            Couldn't load {hostOf(tab.url)} <span className="font-mono text-xs">({activity.error})</span>
          </span>
          <button
            type="button"
            onClick={() => reload(tab.id)}
            className="rounded-lg px-3 py-1 text-xs text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </Message>
      ) : (
        <BrowserSurface threadId={threadId} />
      )}
    </aside>
  );
}

function TabButton({ threadId, tab, active }: { threadId: string; tab: BrowserTab; active: boolean }) {
  const favicon = useBrowser((state) => state.activity[tab.id]?.favicon ?? null);
  const label = tab.title || hostOf(tab.url) || "New tab";
  return (
    <div
      className={cn(
        "group/tab flex h-7 max-w-44 shrink-0 items-center rounded-lg pr-0.5 text-xs transition-colors",
        active ? "bg-muted/60 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={tab.url || label}
        onClick={() => selectTab(threadId, tab.id)}
        className="flex h-full min-w-0 items-center gap-1.5 rounded-lg pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {favicon ? (
          <img src={favicon} alt="" onError={() => updateActivity(tab.id, { favicon: null })} className="size-3.5 shrink-0 rounded-sm" />
        ) : (
          <Globe className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        title="Close tab"
        aria-label={`Close ${label}`}
        onClick={() => closeTab(threadId, tab.id)}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
          active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function AddressBar({ threadId, tab, activity }: { threadId: string; tab: BrowserTab; activity: TabActivity | undefined }) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(tab.url);
  }, [tab.url, editing]);
  useEffect(() => registerAddressInput(threadId, input.current!), [threadId]);
  useEffect(() => {
    if (!tab.url) input.current?.focus();
  }, []);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!navigate(threadId, tab.id, draft)) return setInvalid(true);
        setInvalid(false);
        input.current?.blur();
      }}
      className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-2"
    >
      <IconButton label="Back" disabled={!activity?.canGoBack} onClick={() => goBack(tab.id)}>
        <ArrowLeft className="size-3.5" />
      </IconButton>
      <IconButton label="Forward" disabled={!activity?.canGoForward} onClick={() => goForward(tab.id)}>
        <ArrowRight className="size-3.5" />
      </IconButton>
      {activity?.loading ? (
        <IconButton label="Stop" onClick={() => stop(tab.id)}>
          <X className="size-3.5" />
        </IconButton>
      ) : (
        <IconButton label="Reload" disabled={!tab.url} onClick={() => reload(tab.id)}>
          <RotateCw className="size-3.5" />
        </IconButton>
      )}
      <Input
        ref={input}
        value={draft}
        onChange={(value) => {
          setDraft(value);
          setInvalid(false);
        }}
        onFocus={(event) => {
          setEditing(true);
          event.currentTarget.select();
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setDraft(tab.url);
          event.currentTarget.blur();
        }}
        error={invalid}
        placeholder="Enter address"
        aria-label="Address"
        spellCheck={false}
        className="mx-1 min-w-0 flex-1"
        classNames={{
          field: "h-7 rounded-lg border-transparent bg-muted/60 ring-0 data-[state=focused]:bg-muted",
          input: "selectable px-2.5 font-mono text-xs placeholder:text-muted-foreground",
        }}
      />
      <IconButton label="Open in default browser" disabled={!tab.url} onClick={() => window.open(tab.url, "_blank")}>
        <ExternalLink className="size-3.5" />
      </IconButton>
    </form>
  );
}

function BrowserSurface({ threadId }: { threadId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = slot.current!;
    function publish() {
      const rect = element.getBoundingClientRect();
      setSurface(threadId, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    window.addEventListener("resize", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      clearSurface(threadId);
    };
  }, [threadId]);
  return <div ref={slot} className="min-h-0 flex-1" />;
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
