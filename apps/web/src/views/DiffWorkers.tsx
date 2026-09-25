import { useWorkerPool, WorkerPoolContextProvider } from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { useEffect, useState, useSyncExternalStore } from "react";

export const THEMES = { dark: "pierre-dark", light: "pierre-light" } as const;
export type DiffTheme = keyof typeof THEMES;

const isDark = () => document.documentElement.classList.contains("dark");

const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};

/** The theme on screen, with "system" resolved: follows <html class="dark">. */
export const useResolvedTheme = (): DiffTheme => useSyncExternalStore(subscribeToTheme, () => (isDark() ? "dark" : "light"));

const cores = navigator.hardwareConcurrency || 4;

/**
 * Highlighting runs off the main thread; one pool for the whole window. Tuned like t3code's:
 * half the cores, and room to keep a big diff's highlighted files for scrolling back
 * (the library keeps 100 by default).
 */
const POOL_OPTIONS = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
  poolSize: Math.max(2, Math.min(6, Math.floor(cores / 2))),
  totalASTLRUCacheSize: 240,
};

/**
 * Keep in step with the panel's CodeView options, or cached results won't match.
 * - One theme at a time: highlighting both at once doubles the tokenizing and every token's markup.
 * - The WASM regex engine: faster than the default JS one and can't backtrack catastrophically.
 * Together they highlight a large diff about twice as fast, with a fifth less to send back.
 */
export const HIGHLIGHT = {
  preferredHighlighter: "shiki-wasm",
  lineDiffType: "word",
  tokenizeMaxLineLength: 1_000,
} as const;

const HIGHLIGHTER_OPTIONS = {
  ...HIGHLIGHT,
  theme: THEMES[isDark() ? "dark" : "light"],
  // Preloaded so the first diff doesn't wait on a lazy grammar load; others still load on demand.
  langs: ["typescript", "tsx", "javascript", "json", "css", "html", "markdown", "rust", "toml", "yaml", "bash"],
};

/** The pool is created once; a theme switch re-highlights with the other theme instead. */
const ThemeSync = () => {
  const pool = useWorkerPool();
  const theme = THEMES[useResolvedTheme()];
  useEffect(() => {
    if (!pool || pool.getDiffRenderOptions().theme === theme) return;
    void pool.setRenderOptions({ theme }).catch(() => {});
  }, [pool, theme]);
  return null;
};

/**
 * Whether the pool is up. Rendering before it is paints the diff plain, then again once the
 * highlighting arrives. A pool that failed to start falls back to highlighting on the main thread.
 */
export const useDiffWorkersReady = () => {
  const pool = useWorkerPool();
  const [, setStarted] = useState(0);
  const ready = !pool || pool.isInitialized() || !pool.isWorkingPool();
  useEffect(() => {
    if (ready || !pool) return;
    let mounted = true;
    const done = () => mounted && setStarted((n) => n + 1);
    void pool.initialize().then(done, done);
    return () => {
      mounted = false;
    };
  }, [pool, ready]);
  return ready;
};

/** Mount once near the root: the pool (and its render cache) outlives any one panel. */
export const DiffWorkers = ({ children }: { children: React.ReactNode }) => (
  <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
    <ThemeSync />
    {children}
  </WorkerPoolContextProvider>
);
