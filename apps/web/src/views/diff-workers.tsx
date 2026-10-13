import { useWorkerPool, WorkerPoolContextProvider } from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { useEffect, useState } from "react";

/**
 * Highlighting runs off the main thread; one pool for the whole window. Tuned like t3code's:
 * half the cores, and room to keep a big diff's highlighted files for scrolling back
 * (the library keeps 100 by default).
 */
const POOL_OPTIONS = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
  poolSize: Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
  totalASTLRUCacheSize: 240,
};

/**
 * Keep in step with the panel's CodeView options, or cached results won't match.
 * - Both themes at once, picked by CSS: highlighting one at a time is about twice as fast, but
 *   then a theme switch throws every highlighted diff away and re-renders it (a second of jank).
 * - The WASM regex engine: faster than the default JS one and can't backtrack catastrophically.
 */
export const HIGHLIGHT = {
  theme: { dark: "vesper", light: "pierre-light" },
  preferredHighlighter: "shiki-wasm",
  lineDiffType: "word",
  tokenizeMaxLineLength: 1_000,
} as const;

const HIGHLIGHTER_OPTIONS = {
  ...HIGHLIGHT,
  // Preloaded so the first diff doesn't wait on a lazy grammar load; others still load on demand.
  langs: [
    "typescript",
    "tsx",
    "javascript",
    "json",
    "css",
    "html",
    "markdown",
    "rust",
    "toml",
    "yaml",
    "bash",
  ],
};

/**
 * Whether the pool is up. Rendering before it is paints the diff plain, then again once the
 * highlighting arrives. A pool that failed to start falls back to highlighting on the main thread.
 */
export function useDiffWorkersReady() {
  const pool = useWorkerPool();
  const [, setStarted] = useState(0);
  const isReady = !pool || pool.isInitialized() || !pool.isWorkingPool();

  useEffect(() => {
    if (isReady || !pool) return;
    let isMounted = true;

    function markStarted() {
      if (isMounted) setStarted((count) => count + 1);
    }

    void pool.initialize().then(markStarted, markStarted);

    return () => {
      isMounted = false;
    };
  }, [pool, isReady]);

  return isReady;
}

/** Mount once near the root: the pool (and its render cache) outlives any one panel. */
export function DiffWorkers({ children }: { children: React.ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
      {children}
    </WorkerPoolContextProvider>
  );
}
