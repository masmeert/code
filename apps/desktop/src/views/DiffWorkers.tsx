import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";

export const THEMES = { dark: "pierre-dark", light: "pierre-light" } as const;

/** Highlighting runs off the main thread; one pool for the whole window. Setup follows the library's Vite recipe. */
const POOL_OPTIONS = {
  workerFactory: () => new Worker(WorkerUrl, { type: "module" }),
  poolSize: Math.min(4, navigator.hardwareConcurrency || 2),
};
const HIGHLIGHTER_OPTIONS = {
  theme: THEMES,
  lineDiffType: "word" as const,
  // Preloaded so the first diff doesn't wait on a lazy grammar load; others still load on demand.
  langs: ["typescript", "tsx", "javascript", "json", "css", "html", "markdown", "rust", "toml", "yaml", "bash"],
};

/** Mount once near the root: the pool (and its render cache) outlives any one panel. */
export const DiffWorkers = ({ children }: { children: React.ReactNode }) => (
  <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
    {children}
  </WorkerPoolContextProvider>
);
