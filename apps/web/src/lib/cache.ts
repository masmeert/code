/**
 * Last-known daemon state in IndexedDB, so a relaunch renders your threads right away
 * instead of an empty app while the daemon boots. Modeled on t3code's environment cache
 * (github.com/pingdotgg/t3code, MIT): one "shell" record (thread list, projects,
 * settings) plus one record per opened thread holding its transcript and resume cursor.
 *
 * The daemon always wins: its shell replaces the cached one on connect, and transcripts
 * resume from their cursor. Cached data is never used to decide that something is gone.
 */
import type { PageInfo, Project, ProviderStatus, Settings, ThreadInfo } from "@masscode/contracts";
import type { TranscriptItem } from "./store.ts";

/** Bump when a record's shape changes; older records then read as a cold cache. */
const VERSION = 4;

const DATABASE_NAME = "masscode.cache";

const SHELL = "shell";

const THREADS = "threads";

interface CachedShell {
  readonly version: number;
  readonly dataId: string;
  readonly settings: Settings;
  readonly projects: ReadonlyArray<Project>;
  readonly providers: ReadonlyArray<ProviderStatus>;
  readonly order: ReadonlyArray<string>;
  readonly threads: Readonly<Record<string, ThreadInfo>>;
}

interface CachedTranscript {
  readonly version: number;
  readonly items: ReadonlyArray<TranscriptItem>;
  readonly cursor: number;
  readonly page: PageInfo | null;
}

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    request.onupgradeneeded = () => {
      // Stores from older versions hold shapes we no longer read.
      for (const name of request.result.objectStoreNames) request.result.deleteObjectStore(name);
      request.result.createObjectStore(SHELL);
      request.result.createObjectStore(THREADS);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

async function readRecord<A extends { version: number }>(
  store: string,
  key: string,
): Promise<A | null> {
  try {
    const connection = await openDatabase();

    const value = await new Promise<unknown>((resolve, reject) => {
      const request = connection.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // SAFETY: only saveShell/saveTranscript write these stores, and a record from another version is dropped below.
    const record = value as A | undefined;

    return record?.version === VERSION ? record : null;
  } catch {
    return null;
  }
}

function getThreadKey(dataId: string, threadId: string) {
  return `${dataId}:${threadId}`;
}

export function loadShell() {
  return readRecord<CachedShell>(SHELL, "shell");
}

export function loadTranscript(dataId: string, threadId: string) {
  return readRecord<CachedTranscript>(THREADS, getThreadKey(dataId, threadId));
}

// Writes are debounced (streaming deltas arrive many times a second) and only the
// latest value per key is kept.
const pending = new Map<
  string,
  { readonly store: string; readonly value: CachedShell | CachedTranscript | undefined }
>();

let timer: ReturnType<typeof setTimeout> | null = null;

async function flushWrites() {
  timer = null;

  if (pending.size === 0) return;

  const writes = [...pending];
  pending.clear();

  try {
    const connection = await openDatabase();
    const transaction = connection.transaction([SHELL, THREADS], "readwrite");

    for (const [key, { store, value }] of writes) {
      const objects = transaction.objectStore(store);
      const id = key.slice(store.length + 1);

      if (value === undefined) objects.delete(id);
      else objects.put(value, id);
    }
  } catch {}
}

function queueWrite(store: string, id: string, value: CachedShell | CachedTranscript | undefined) {
  pending.set(`${store}:${id}`, { store, value });
  timer ??= setTimeout(flushWrites, 500);
}

export function saveShell(shell: Omit<CachedShell, "version">) {
  queueWrite(SHELL, "shell", { version: VERSION, ...shell });
}

export function saveTranscript(
  dataId: string,
  threadId: string,
  transcript: Omit<CachedTranscript, "version">,
) {
  queueWrite(THREADS, getThreadKey(dataId, threadId), { version: VERSION, ...transcript });
}

export function removeTranscript(dataId: string, threadId: string) {
  queueWrite(THREADS, getThreadKey(dataId, threadId), undefined);
}

// Don't lose the last half second on quit.
window.addEventListener("pagehide", () => {
  if (timer) clearTimeout(timer);
  void flushWrites();
});
