import type { BrowserAction, BrowserResult } from "@apcode/contracts";
import { useSyncExternalStore } from "react";

export interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getWebContentsId(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}

export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

export interface ThreadBrowser {
  readonly open: boolean;
  readonly tabs: ReadonlyArray<BrowserTab>;
  readonly activeTabId: string | null;
}

export interface TabActivity {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly favicon: string | null;
  readonly error: string | null;
  readonly automating: number;
}

export interface SurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserState {
  readonly threads: Readonly<Record<string, ThreadBrowser>>;
  readonly activity: Readonly<Record<string, TabActivity | undefined>>;
  readonly alive: ReadonlyArray<{ readonly threadId: string; readonly tabId: string }>;
  readonly surface: { readonly threadId: string; readonly rect: SurfaceRect } | null;
}

const STORAGE_KEY = "apcode.browser";

function readThreads(): Record<string, ThreadBrowser> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

let state: BrowserState = { threads: readThreads(), activity: {}, alive: [], surface: null };
const listeners = new Set<() => void>();
const webviews = new Map<string, Webview>();
const addressInputs = new Map<string, HTMLInputElement>();

function setState(next: BrowserState) {
  if (next.threads !== state.threads) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next.threads));
    } catch {}
  }
  state = next;
  for (const listener of listeners) listener();
}

export function useBrowser<A>(select: (state: BrowserState) => A): A {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
}

function threadBrowser(threadId: string): ThreadBrowser {
  return state.threads[threadId] ?? { open: false, tabs: [], activeTabId: null };
}

function updateThread(threadId: string, update: (browser: ThreadBrowser) => ThreadBrowser) {
  setState({
    ...state,
    threads: { ...state.threads, [threadId]: update(threadBrowser(threadId)) },
  });
}

export function isLocalUrl(url: string) {
  try {
    return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${isLocalUrl(`http://${trimmed}`) ? "http" : "https"}://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function toggleBrowser(threadId: string) {
  const browser = threadBrowser(threadId);
  if (!browser.open && browser.tabs.length === 0) return openTab(threadId);
  updateThread(threadId, (current) => ({ ...current, open: !current.open }));
}

export function openTab(threadId: string, url = "") {
  const tab = { id: crypto.randomUUID(), url, title: "" };
  updateThread(threadId, (current) => ({
    open: true,
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  }));
}

export function closeTab(threadId: string, tabId: string) {
  const browser = threadBrowser(threadId);
  const index = browser.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = browser.tabs.filter((tab) => tab.id !== tabId);
  const { [tabId]: _closed, ...activity } = state.activity;
  setState({
    ...state,
    activity,
    alive: state.alive.filter((entry) => entry.tabId !== tabId),
    threads: {
      ...state.threads,
      [threadId]: {
        open: browser.open && tabs.length > 0,
        tabs,
        activeTabId:
          browser.activeTabId === tabId
            ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
            : browser.activeTabId,
      },
    },
  });
}

export function selectTab(threadId: string, tabId: string) {
  updateThread(threadId, (current) => ({ ...current, activeTabId: tabId }));
}

export function updateTab(
  threadId: string,
  tabId: string,
  patch: Partial<Pick<BrowserTab, "url" | "title">>,
) {
  updateThread(threadId, (current) => ({
    ...current,
    tabs: current.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
  }));
}

export function updateActivity(tabId: string, patch: Partial<TabActivity>) {
  setState({
    ...state,
    activity: {
      ...state.activity,
      [tabId]: {
        canGoBack: false,
        canGoForward: false,
        loading: false,
        favicon: null,
        error: null,
        automating: 0,
        ...state.activity[tabId],
        ...patch,
      },
    },
  });
}

export function navigate(threadId: string, tabId: string, input: string) {
  const url = normalizeUrl(input);
  if (!url) return false;
  webviews
    .get(tabId)
    ?.loadURL(url)
    .catch(() => {});
  updateTab(threadId, tabId, { url });
  return true;
}

export function goBack(tabId: string) {
  webviews.get(tabId)?.goBack();
}

export function goForward(tabId: string) {
  webviews.get(tabId)?.goForward();
}

export function reload(tabId: string) {
  updateActivity(tabId, { error: null });
  webviews.get(tabId)?.reload();
}

export function stop(tabId: string) {
  webviews.get(tabId)?.stop();
}

export function showTab(threadId: string, tabId: string) {
  if (state.alive.at(-1)?.tabId === tabId) return;
  setState({
    ...state,
    alive: [...state.alive.filter((entry) => entry.tabId !== tabId), { threadId, tabId }].slice(-8),
  });
}

export function setSurface(threadId: string, rect: SurfaceRect) {
  const current = state.surface;
  if (
    current?.threadId === threadId &&
    current.rect.x === rect.x &&
    current.rect.y === rect.y &&
    current.rect.width === rect.width &&
    current.rect.height === rect.height
  )
    return;
  setState({ ...state, surface: { threadId, rect } });
}

export function clearSurface(threadId: string) {
  if (state.surface?.threadId === threadId) setState({ ...state, surface: null });
}

export function registerWebview(tabId: string, webview: Webview) {
  webviews.set(tabId, webview);
  return () => {
    if (webviews.get(tabId) === webview) webviews.delete(tabId);
  };
}

export function registerAddressInput(threadId: string, input: HTMLInputElement) {
  addressInputs.set(threadId, input);
  return () => {
    if (addressInputs.get(threadId) === input) addressInputs.delete(threadId);
  };
}

export function focusAddress(threadId: string) {
  addressInputs.get(threadId)?.focus();
}

export function tabForWebContents(webContentsId: number) {
  for (const [tabId, webview] of webviews) {
    try {
      if (webview.getWebContentsId() !== webContentsId) continue;
    } catch {
      continue;
    }
    const threadId = Object.keys(state.threads).find((id) =>
      state.threads[id]!.tabs.some((tab) => tab.id === tabId),
    );
    return threadId ? { threadId, tabId } : null;
  }
  return null;
}

function activeTab(threadId: string) {
  const browser = threadBrowser(threadId);
  return browser.tabs.find((tab) => tab.id === browser.activeTabId);
}

async function attachedWebview(tabId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const webview = webviews.get(tabId);
    try {
      if (webview && webview.getWebContentsId() > 0) return webview;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The browser tab didn't start");
}

export async function performBrowserAction(
  threadId: string,
  action: BrowserAction,
): Promise<BrowserResult> {
  const desktop = window.desktop;
  if (!desktop) throw new Error("The browser is only available in the APCode desktop app");
  const url = action._tag === "navigate" ? normalizeUrl(action.url) : null;
  if (action._tag === "navigate" && !url) throw new Error(`Not a web address: ${action.url}`);
  const current = activeTab(threadId);
  if (!current?.url && !url)
    throw new Error("No page is open in the browser; navigate to one first");
  if (!current) openTab(threadId, url!);
  else if (!current.url) updateTab(threadId, current.id, { url: url! });
  if (!threadBrowser(threadId).open)
    updateThread(threadId, (browser) => ({ ...browser, open: true }));
  const tab = activeTab(threadId)!;
  showTab(threadId, tab.id);
  updateActivity(tab.id, { automating: (state.activity[tab.id]?.automating ?? 0) + 1 });
  try {
    const webview = await attachedWebview(tab.id);
    return await desktop.automateBrowser(
      webview.getWebContentsId(),
      !current?.url ? { _tag: "status" } : url ? { _tag: "navigate", url } : action,
    );
  } catch (error) {
    throw new Error(
      String(error instanceof Error ? error.message : error).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        "",
      ),
    );
  } finally {
    updateActivity(tab.id, {
      automating: Math.max(0, (state.activity[tab.id]?.automating ?? 1) - 1),
    });
  }
}
