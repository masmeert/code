/**
 * Last-known daemon state in IndexedDB, so a relaunch renders your threads right away
 * instead of an empty app while the daemon boots. Modeled on t3code's environment cache
 * (github.com/pingdotgg/t3code, MIT): one "shell" record (thread list, projects,
 * settings) plus one record per opened thread holding its transcript and resume cursor.
 *
 * The daemon always wins: its shell replaces the cached one on connect, and transcripts
 * resume from their cursor. Cached data is never used to decide that something is gone.
 */
import type { PageInfo, Project, ProviderStatus, Settings, ThreadInfo } from "@apcode/contracts";
import type { TranscriptItem } from "./store.ts";

/** Bump when a record's shape changes; older records then read as a cold cache. */
const VERSION = 3;
const DB = "apcode.cache";
const SHELL = "shell";
const THREADS = "threads";

export interface CachedShell {
  readonly version: number;
  readonly dataId: string;
  readonly settings: Settings;
  readonly projects: ReadonlyArray<Project>;
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly order: ReadonlyArray<string>;
  readonly threads: Readonly<Record<string, ThreadInfo>>;
}

export interface CachedTranscript {
  readonly version: number;
  readonly items: ReadonlyArray<TranscriptItem>;
  readonly cursor: number;
  readonly page: PageInfo | null;
}

let db: Promise<IDBDatabase> | null = null;
const open = () =>
  (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      // Stores from older versions hold shapes we no longer read.
      for (const name of [...req.result.objectStoreNames]) req.result.deleteObjectStore(name);
      req.result.createObjectStore(SHELL);
      req.result.createObjectStore(THREADS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

const get = async <A extends { version: number }>(
  store: string,
  key: string,
): Promise<A | null> => {
  try {
    const conn = await open();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = conn.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = value as A | undefined;
    return record?.version === VERSION ? record : null;
  } catch {
    return null;
  }
};

const threadKey = (dataId: string, threadId: string) => `${dataId}:${threadId}`;

export const loadShell = () => get<CachedShell>(SHELL, "shell");
export const loadTranscript = (dataId: string, threadId: string) =>
  get<CachedTranscript>(THREADS, threadKey(dataId, threadId));

// Writes are debounced (streaming deltas arrive many times a second) and only the
// latest value per key is kept.
const pending = new Map<string, { readonly store: string; readonly value: unknown }>();
let timer: ReturnType<typeof setTimeout> | null = null;

const flush = async () => {
  timer = null;
  if (pending.size === 0) return;
  const writes = [...pending];
  pending.clear();
  try {
    const conn = await open();
    const tx = conn.transaction([SHELL, THREADS], "readwrite");
    for (const [key, { store, value }] of writes) {
      const objects = tx.objectStore(store);
      const id = key.slice(store.length + 1);
      if (value === undefined) objects.delete(id);
      else objects.put(value, id);
    }
  } catch {}
};

const queue = (store: string, id: string, value: unknown) => {
  pending.set(`${store}:${id}`, { store, value });
  timer ??= setTimeout(flush, 500);
};

export const saveShell = (shell: Omit<CachedShell, "version">) =>
  queue(SHELL, "shell", { version: VERSION, ...shell });
export const saveTranscript = (
  dataId: string,
  threadId: string,
  transcript: Omit<CachedTranscript, "version">,
) => queue(THREADS, threadKey(dataId, threadId), { version: VERSION, ...transcript });
export const removeTranscript = (dataId: string, threadId: string) =>
  queue(THREADS, threadKey(dataId, threadId), undefined);

// Don't lose the last half second on quit.
window.addEventListener("pagehide", () => {
  if (timer) clearTimeout(timer);
  void flush();
});
