import { BROWSER_PARTITION } from "@apcode/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type BrowserTab,
  closeTab,
  focusAddress,
  openTab,
  registerWebview,
  type SurfaceRect,
  tabForWebContents,
  updateActivity,
  updateTab,
  useBrowser,
  type Webview,
} from "../lib/browser.ts";
import { useStore } from "../lib/store.ts";

export function BrowserHost() {
  const threads = useStore((state) => state.threads);
  const browsers = useBrowser((state) => state.threads);
  const alive = useBrowser((state) => state.alive);
  const surface = useBrowser((state) => state.surface);
  const activity = useBrowser((state) => state.activity);

  useEffect(
    () =>
      window.desktop?.onBrowserEvent((event) => {
        const owner = tabForWebContents(event.webContentsId);
        if (!owner) return;
        if (event._tag === "open-tab") openTab(owner.threadId, event.url);
        else if (event._tag === "new-tab") openTab(owner.threadId);
        else if (event._tag === "close-tab") closeTab(owner.threadId, owner.tabId);
        else focusAddress(owner.threadId);
      }),
    [],
  );

  if (!window.desktop) return null;
  const shown = surface && browsers[surface.threadId]?.open ? browsers[surface.threadId]?.activeTabId : null;
  return createPortal(
    alive.flatMap(({ threadId, tabId }) => {
      const tab = browsers[threadId]?.tabs.find((candidate) => candidate.id === tabId);
      if (!tab?.url || !threads[threadId]) return [];
      return [
        <HostedTab
          key={tabId}
          threadId={threadId}
          tab={tab}
          rect={shown === tabId && !activity[tabId]?.error ? (surface?.rect ?? null) : null}
        />,
      ];
    }),
    document.body,
  );
}

function HostedTab({ threadId, tab, rect }: { threadId: string; tab: BrowserTab; rect: SurfaceRect | null }) {
  const [initialUrl] = useState(tab.url);
  const [generation, setGeneration] = useState(0);
  const [hiddenSize, setHiddenSize] = useState({ width: 1024, height: 768 });
  const webview = useRef<Webview>(null);
  const crashedAt = useRef(0);

  useEffect(() => {
    if (rect) setHiddenSize({ width: rect.width, height: rect.height });
  }, [rect?.width, rect?.height]);

  useLayoutEffect(() => {
    const element = webview.current!;
    function syncHistory() {
      try {
        updateActivity(tab.id, { canGoBack: element.canGoBack(), canGoForward: element.canGoForward() });
      } catch {}
    }
    const handlers: Record<string, (event: Event & Record<string, unknown>) => void> = {
      "dom-ready": syncHistory,
      "did-start-loading": () => updateActivity(tab.id, { loading: true, error: null }),
      "did-stop-loading": () => {
        updateActivity(tab.id, { loading: false });
        syncHistory();
      },
      "did-navigate": (event) => {
        updateTab(threadId, tab.id, { url: String(event.url) });
        syncHistory();
      },
      "did-navigate-in-page": (event) => {
        if (!event.isMainFrame) return;
        updateTab(threadId, tab.id, { url: String(event.url) });
        syncHistory();
      },
      "page-title-updated": (event) => updateTab(threadId, tab.id, { title: String(event.title) }),
      "page-favicon-updated": (event) => updateActivity(tab.id, { favicon: (event.favicons as ReadonlyArray<string>)[0] ?? null }),
      "did-fail-load": (event) => {
        if (event.isMainFrame && event.errorDescription !== "ERR_ABORTED") {
          updateActivity(tab.id, { loading: false, error: String(event.errorDescription) });
        }
      },
      "render-process-gone": () => {
        if (Date.now() - crashedAt.current < 10_000) return updateActivity(tab.id, { error: "The page crashed" });
        crashedAt.current = Date.now();
        setGeneration((value) => value + 1);
      },
      focus: () => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    };
    for (const [name, handler] of Object.entries(handlers)) element.addEventListener(name, handler as EventListener);
    const unregister = registerWebview(tab.id, element);
    return () => {
      for (const [name, handler] of Object.entries(handlers)) element.removeEventListener(name, handler as EventListener);
      unregister();
    };
  }, [generation]);

  return (
    <webview
      key={generation}
      ref={webview}
      src={generation === 0 ? initialUrl : tab.url}
      partition={BROWSER_PARTITION}
      {...({ allowpopups: "true" } as unknown as { allowpopups?: boolean })}
      aria-hidden={rect ? undefined : true}
      className="fixed z-10 bg-white"
      style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : { left: -100_000, top: 0, ...hiddenSize }}
    />
  );
}
