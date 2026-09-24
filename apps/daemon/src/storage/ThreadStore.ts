import { RuntimeEvent, type ProviderKind, type ThreadInfo } from "@apcode/contracts";
import { Database } from "bun:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./jsonFile.ts";

export interface StoredThread {
  readonly info: ThreadInfo;
  readonly resumeToken: string | null;
}

/** Events worth replaying after a restart. Deltas are folded into `assistant.completed`; status is live-only. */
export const isPersisted = (event: RuntimeEvent) =>
  event._tag !== "assistant.delta" &&
  event._tag !== "thread.status" &&
  event._tag !== "thread.model" &&
  event._tag !== "thread.meta" &&
  event._tag !== "thread.archived" &&
  "threadId" in event &&
  event.threadId !== null;

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    /** All threads (oldest first) plus their persisted events in order. */
    readonly load: Effect.Effect<{ readonly threads: ReadonlyArray<StoredThread>; readonly events: ReadonlyArray<RuntimeEvent> }>;
    readonly insertThread: (info: ThreadInfo) => void;
    readonly setResumeToken: (threadId: string, token: string) => void;
    readonly setModel: (threadId: string, model: string | null) => void;
    readonly setArchived: (threadId: string, archivedAt: number | null) => void;
    readonly setMeta: (threadId: string, meta: { readonly title: string; readonly updatedAt: number }) => void;
    readonly appendEvent: (threadId: string, event: RuntimeEvent) => void;
    readonly deleteThread: (threadId: string) => void;
  }
>()("apcode/ThreadStore") {}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeEvent));

const make = Effect.acquireRelease(
  Effect.sync(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    const db = new Database(join(DATA_DIR, "apcode.db"), { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resume_token TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      json TEXT NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id)");
    // Migrations for databases created before a column existed.
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(threads)").all().map((c) => c.name));
    if (!columns.has("model")) db.run("ALTER TABLE threads ADD COLUMN model TEXT");
    if (!columns.has("archived_at")) db.run("ALTER TABLE threads ADD COLUMN archived_at INTEGER");
    if (!columns.has("updated_at")) {
      db.run("ALTER TABLE threads ADD COLUMN updated_at INTEGER");
      db.run("UPDATE threads SET updated_at = created_at");
    }
    return db;
  }),
  (db) => Effect.sync(() => db.close()),
).pipe(
  Effect.map((db) => {
    const insertThread = db.prepare(
      "INSERT INTO threads (id, project_id, provider, model, cwd, title, created_at, updated_at) VALUES ($id, $projectId, $provider, $model, $cwd, $title, $createdAt, $updatedAt)",
    );
    const setMeta = db.prepare("UPDATE threads SET title = $title, updated_at = $updatedAt WHERE id = $id");
    const setModel = db.prepare("UPDATE threads SET model = $model WHERE id = $id");
    const setArchived = db.prepare("UPDATE threads SET archived_at = $archivedAt WHERE id = $id");
    const setResumeToken = db.prepare("UPDATE threads SET resume_token = $token WHERE id = $id");
    const appendEvent = db.prepare("INSERT INTO events (thread_id, json) VALUES ($threadId, $json)");
    const deleteThread = db.prepare("DELETE FROM threads WHERE id = $id");

    return ThreadStore.of({
      load: Effect.sync(() => {
        const rows = db
          .query<
            { id: string; project_id: string; provider: ProviderKind; model: string | null; cwd: string; title: string; created_at: number; updated_at: number; archived_at: number | null; resume_token: string | null },
            []
          >("SELECT * FROM threads ORDER BY created_at")
          .all();
        const threads = rows.map((row) => ({
          info: {
            id: row.id,
            projectId: row.project_id,
            provider: row.provider,
            model: row.model,
            cwd: row.cwd,
            title: row.title,
            status: "idle" as const,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            branch: null,
            archivedAt: row.archived_at,
          },
          resumeToken: row.resume_token,
        }));
        const events = db
          .query<{ json: string }, []>("SELECT json FROM events ORDER BY seq")
          .all()
          .flatMap((row) => {
            const decoded = decodeEvent(row.json);
            return decoded._tag === "Some" ? [decoded.value] : [];
          });
        return { threads, events };
      }),
      insertThread: (info) => {
        insertThread.run({
          id: info.id,
          projectId: info.projectId,
          provider: info.provider,
          model: info.model,
          cwd: info.cwd,
          title: info.title,
          createdAt: info.createdAt,
          updatedAt: info.updatedAt,
        });
      },
      setResumeToken: (id, token) => {
        setResumeToken.run({ id, token });
      },
      setArchived: (id, archivedAt) => {
        setArchived.run({ id, archivedAt });
      },
      setModel: (id, model) => {
        setModel.run({ id, model });
      },
      setMeta: (id, meta) => {
        setMeta.run({ id, ...meta });
      },
      appendEvent: (threadId, event) => {
        appendEvent.run({ threadId, json: JSON.stringify(event) });
      },
      deleteThread: (id) => {
        deleteThread.run({ id });
      },
    });
  }),
);

export const layer = Layer.effect(ThreadStore, make);
