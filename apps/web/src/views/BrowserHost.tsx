import { BROWSER_PARTITION, DesktopBrowserEvent } from "@apcode/contracts";
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
        DesktopBrowserEvent.match(event, {
          "open-tab": ({ url }) => openTab(owner.threadId, url),
          "new-tab": () => openTab(owner.threadId),
          "close-tab": () => closeTab(owner.threadId, owner.tabId),
          "focus-address": () => focusAddress(owner.threadId),
        });
      }),
    [],
  );

  if (!window.desktop) return null;
  const shown =
    surface && browsers[surface.threadId]?.open ? browsers[surface.threadId]?.activeTabId : null;
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
          automating={(activity[tabId]?.automating ?? 0) > 0}
        />,
      ];
    }),
    document.body,
  );
}

/** Fields Electron sets on the `<webview>` events handled here. */
interface WebviewEvent extends Event {
  readonly url: string;
  readonly title: string;
  readonly isMainFrame: boolean;
  readonly errorDescription: string;
  readonly favicons: ReadonlyArray<string>;
}

function HostedTab({
  threadId,
  tab,
  rect,
  automating,
}: {
  threadId: string;
  tab: BrowserTab;
  rect: SurfaceRect | null;
  automating: boolean;
}) {
  const [initialUrl] = useState(tab.url);
  const [generation, setGeneration] = useState(0);
  const [hiddenSize, setHiddenSize] = useState({ width: 1024, height: 768 });
  const webview = useRef<Webview>(null);
  const crashedAt = useRef(0);

  const width = rect?.width;
  const height = rect?.height;
  useEffect(() => {
    if (width !== undefined && height !== undefined) setHiddenSize({ width, height });
  }, [width, height]);

  useLayoutEffect(() => {
    const element = webview.current!;
    function syncHistory() {
      try {
        updateActivity(tab.id, {
          canGoBack: element.canGoBack(),
          canGoForward: element.canGoForward(),
        });
      } catch {}
    }
    const handlers = {
      "dom-ready": syncHistory,
      "did-start-loading": () => updateActivity(tab.id, { loading: true, error: null }),
      "did-stop-loading": () => {
        updateActivity(tab.id, { loading: false });
        syncHistory();
      },
      "did-navigate": (event: WebviewEvent) => {
        updateTab(threadId, tab.id, { url: event.url });
        syncHistory();
      },
      "did-navigate-in-page": (event: WebviewEvent) => {
        if (!event.isMainFrame) return;
        updateTab(threadId, tab.id, { url: event.url });
        syncHistory();
      },
      "page-title-updated": (event: WebviewEvent) =>
        updateTab(threadId, tab.id, { title: event.title }),
      "page-favicon-updated": (event: WebviewEvent) =>
        updateActivity(tab.id, { favicon: event.favicons[0] ?? null }),
      "did-fail-load": (event: WebviewEvent) => {
        if (event.isMainFrame && event.errorDescription !== "ERR_ABORTED") {
          updateActivity(tab.id, { loading: false, error: event.errorDescription });
        }
      },
      "render-process-gone": () => {
        if (Date.now() - crashedAt.current < 10_000)
          return updateActivity(tab.id, { error: "The page crashed" });
        crashedAt.current = Date.now();
        setGeneration((value) => value + 1);
      },
      focus: () => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    };
    // SAFETY: Electron dispatches each of these events with the WebviewEvent fields its handler reads.
    const listeners = Object.entries(handlers) as Array<[string, EventListener]>;
    for (const [name, listener] of listeners) element.addEventListener(name, listener);
    const unregister = registerWebview(tab.id, element);
    return () => {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener);
      unregister();
    };
  }, [generation, threadId, tab.id]);

  return (
    <webview
      key={generation}
      ref={webview}
      src={generation === 0 ? initialUrl : tab.url}
      partition={BROWSER_PARTITION}
      // SAFETY: Electron only checks that the attribute exists, and React drops a boolean one; its typings say boolean.
      allowpopups={"true" as never}
      aria-hidden={rect ? undefined : true}
      className="fixed z-10 bg-white"
      style={
        rect
          ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
          : automating
            ? { left: 0, top: 0, zIndex: -1, pointerEvents: "none", ...hiddenSize }
            : { left: -100_000, top: 0, ...hiddenSize }
      }
    />
  );
}
