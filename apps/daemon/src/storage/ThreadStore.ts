import {
  isTranscriptEvent,
  RuntimeEvent,
  type PageInfo,
  type ProviderKind,
  type SearchHit,
  type StoredEvent,
  type ThreadInfo,
} from "@apcode/contracts";
import { Database } from "bun:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./jsonFile.ts";

export interface StoredThread {
  readonly info: ThreadInfo;
  readonly resumeToken: string | null;
}

/** Events worth replaying after a restart: the transcript, with deltas folded into `assistant.completed`. */
export function isPersisted(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { threadId: string }> {
  return (
    isTranscriptEvent(event) && !RuntimeEvent.isAnyOf(["assistant.delta", "tool.progress"])(event)
  );
}

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    /** Identifies this database; clients key their caches by it. */
    readonly dataId: string;
    /** All threads, oldest first. Transcripts stay on disk until a client asks for one. */
    readonly load: Effect.Effect<ReadonlyArray<StoredThread>>;
    /** Approvals requested but never resolved, as `[requestId, threadId]`. */
    readonly unresolvedApprovals: () => ReadonlyArray<readonly [string, string]>;
    readonly firstUserMessage: (threadId: string) => string | null;
    /** Newest stored event id of a thread; 0 if none. */
    readonly cursor: (threadId: string) => number;
    /** How many events come after id `after`, and their encoded size, without reading them. */
    readonly measureAfter: (
      threadId: string,
      after: number,
    ) => { readonly count: number; readonly bytes: number };
    /** Events after id `after`, oldest first. */
    readonly readAfter: (threadId: string, after: number) => ReadonlyArray<StoredEvent>;
    /**
     * The last `turnLimit` turns before id `before` (a turn starts at a user message),
     * with where they start so older ones can be fetched later.
     */
    readonly readTurns: (
      threadId: string,
      turnLimit: number,
      before?: number,
    ) => { readonly events: ReadonlyArray<StoredEvent>; readonly page: PageInfo | null };
    readonly insertThread: (info: ThreadInfo) => void;
    /** Null starts the provider conversation over on the next message. */
    readonly setResumeToken: (threadId: string, token: string | null) => void;
    /** Where user message `messageId` is in the thread, and the ids of the user messages from it on. */
    readonly findUserMessage: (
      threadId: string,
      messageId: string,
    ) => {
      readonly seq: number;
      readonly event: Extract<RuntimeEvent, { _tag: "user.message" }>;
      /** User messages before it. */
      readonly before: number;
      readonly from: ReadonlyArray<Extract<RuntimeEvent, { _tag: "user.message" }>>;
    } | null;
    /** Deletes the thread's events from id `seq` on. */
    readonly truncate: (threadId: string, seq: number) => void;
    /** Messages matching `query` (words, prefix-matched), newest first. */
    readonly search: (query: string, limit: number) => ReadonlyArray<SearchHit>;
    readonly setModel: (threadId: string, model: string | null) => void;
    readonly setArchived: (threadId: string, archivedAt: number | null) => void;
    readonly setMeta: (
      threadId: string,
      meta: { readonly title: string; readonly updatedAt: number },
    ) => void;
    /** Returns the new event's id. */
    readonly appendEvent: (threadId: string, event: RuntimeEvent) => number;
    readonly deleteThread: (threadId: string) => void;
  }
>()("apcode/ThreadStore") {}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeEvent));

const make = Effect.acquireRelease(
  Effect.sync(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    const db = new Database(join(DATA_DIR, "apcode.db"), { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL");
    // With WAL, NORMAL only fsyncs at checkpoints: still safe against corruption, much cheaper per append.
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 5000");
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
    // The event's tag as a column, so turns and approvals are found without decoding every row.
    const eventColumns = new Set(
      db
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .map((c) => c.name),
    );
    if (!eventColumns.has("kind")) db.run("ALTER TABLE events ADD COLUMN kind TEXT");
    const untagged = db
      .query<{ seq: number; json: string }, []>("SELECT seq, json FROM events WHERE kind IS NULL")
      .all();
    if (untagged.length) {
      const setKind = db.prepare("UPDATE events SET kind = $kind WHERE seq = $seq");
      db.transaction(() => {
        for (const row of untagged)
          setKind.run({
            seq: row.seq,
            kind:
              Option.getOrUndefined(
                Schema.decodeUnknownOption(
                  Schema.fromJsonString(Schema.Struct({ _tag: Schema.optional(Schema.String) })),
                )(row.json),
              )?._tag ?? "",
          });
      })();
    }
    db.run("CREATE INDEX IF NOT EXISTS events_thread_kind ON events(thread_id, kind, seq)");
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('data_id', $id)").run({
      id: crypto.randomUUID(),
    });
    // Migrations for databases created before a column existed.
    const columns = new Set(
      db
        .query<{ name: string }, []>("PRAGMA table_info(threads)")
        .all()
        .map((c) => c.name),
    );
    if (!columns.has("model")) db.run("ALTER TABLE threads ADD COLUMN model TEXT");
    if (!columns.has("archived_at")) db.run("ALTER TABLE threads ADD COLUMN archived_at INTEGER");
    if (!columns.has("updated_at")) {
      db.run("ALTER TABLE threads ADD COLUMN updated_at INTEGER");
      db.run("UPDATE threads SET updated_at = created_at");
    }
    if (!columns.has("worktree"))
      db.run("ALTER TABLE threads ADD COLUMN worktree INTEGER NOT NULL DEFAULT 0");
    // Full-text index of what was said, for search. Filled as messages are stored; built from the log once.
    const hasSearch =
      db.query("SELECT name FROM sqlite_master WHERE name = 'messages_fts'").get() !== null;
    if (!hasSearch) {
      db.run(
        `CREATE VIRTUAL TABLE messages_fts USING fts5(text, thread_id UNINDEXED, message_id UNINDEXED, sender UNINDEXED, seq UNINDEXED, tokenize = "unicode61 remove_diacritics 2")`,
      );
      db.run(`INSERT INTO messages_fts (text, thread_id, message_id, sender, seq)
        SELECT json_extract(json, '$.text'), thread_id, json_extract(json, '$.messageId'),
          CASE kind WHEN 'user.message' THEN 'user' ELSE 'assistant' END, seq
        FROM events WHERE kind IN ('user.message', 'assistant.completed') AND json_extract(json, '$.text') != ''`);
    }
    return db;
  }),
  (db) => Effect.sync(() => db.close()),
).pipe(
  Effect.map((db) => {
    const insertThread = db.prepare(
      "INSERT INTO threads (id, project_id, provider, model, cwd, title, created_at, updated_at, worktree) VALUES ($id, $projectId, $provider, $model, $cwd, $title, $createdAt, $updatedAt, $worktree)",
    );
    const setMeta = db.prepare(
      "UPDATE threads SET title = $title, updated_at = $updatedAt WHERE id = $id",
    );
    const setModel = db.prepare("UPDATE threads SET model = $model WHERE id = $id");
    const setArchived = db.prepare("UPDATE threads SET archived_at = $archivedAt WHERE id = $id");
    const setResumeToken = db.prepare("UPDATE threads SET resume_token = $token WHERE id = $id");
    const appendEvent = db.prepare(
      "INSERT INTO events (thread_id, kind, json) VALUES ($threadId, $kind, $json)",
    );
    const indexMessage = db.prepare(
      "INSERT INTO messages_fts (text, thread_id, message_id, sender, seq) VALUES ($text, $threadId, $messageId, $sender, $seq)",
    );
    const selectUserMessages = db.prepare<{ seq: number; json: string }, { threadId: string }>(
      "SELECT seq, json FROM events WHERE thread_id = $threadId AND kind = 'user.message' ORDER BY seq",
    );
    const truncateEvents = db.prepare(
      "DELETE FROM events WHERE thread_id = $threadId AND seq >= $seq",
    );
    const truncateIndex = db.prepare(
      "DELETE FROM messages_fts WHERE thread_id = $threadId AND seq >= $seq",
    );
    const deleteIndex = db.prepare("DELETE FROM messages_fts WHERE thread_id = $threadId");
    const selectSearch = db.prepare<
      { thread_id: string; message_id: string; sender: "user" | "assistant"; snippet: string },
      { query: string; limit: number }
    >(
      `SELECT thread_id, message_id, sender, snippet(messages_fts, 0, char(57344), char(57345), '…', 16) AS snippet
       FROM messages_fts WHERE messages_fts MATCH $query ORDER BY seq DESC LIMIT $limit`,
    );
    const dataId = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'data_id'")
      .get()!.value;
    const toStored = (rows: ReadonlyArray<{ seq: number; json: string }>): Array<StoredEvent> =>
      rows.flatMap((row) =>
        Option.match(decodeEvent(row.json), {
          onNone: () => [],
          onSome: (event) => [{ id: row.seq, event }],
        }),
      );
    const selectAfter = db.prepare<
      { seq: number; json: string },
      { threadId: string; after: number }
    >("SELECT seq, json FROM events WHERE thread_id = $threadId AND seq > $after ORDER BY seq");
    const selectMeasure = db.prepare<
      { count: number; bytes: number | null },
      { threadId: string; after: number }
    >(
      "SELECT COUNT(*) AS count, SUM(length(CAST(json AS BLOB))) AS bytes FROM events WHERE thread_id = $threadId AND seq > $after",
    );
    const selectRange = db.prepare<
      { seq: number; json: string },
      { threadId: string; from: number; before: number }
    >(
      "SELECT seq, json FROM events WHERE thread_id = $threadId AND seq >= $from AND seq < $before ORDER BY seq",
    );
    const selectTurnStart = db.prepare<
      { seq: number },
      { threadId: string; before: number; offset: number }
    >(
      "SELECT seq FROM events WHERE thread_id = $threadId AND kind = 'user.message' AND seq < $before ORDER BY seq DESC LIMIT 1 OFFSET $offset",
    );
    const selectOlder = db.prepare<{ seq: number }, { threadId: string; before: number }>(
      "SELECT seq FROM events WHERE thread_id = $threadId AND seq < $before LIMIT 1",
    );
    const selectCursor = db.prepare<{ seq: number | null }, { threadId: string }>(
      "SELECT MAX(seq) AS seq FROM events WHERE thread_id = $threadId",
    );
    const selectApprovals = db.prepare<{ thread_id: string; kind: string; json: string }, []>(
      "SELECT thread_id, kind, json FROM events WHERE kind IN ('approval.requested', 'approval.resolved') ORDER BY seq",
    );
    const selectFirstUser = db.prepare<{ json: string }, { threadId: string }>(
      "SELECT json FROM events WHERE thread_id = $threadId AND kind = 'user.message' ORDER BY seq LIMIT 1",
    );
    const deleteThread = db.prepare("DELETE FROM threads WHERE id = $id");

    return ThreadStore.of({
      dataId,
      load: Effect.sync(() =>
        db
          .query<
            {
              id: string;
              project_id: string;
              provider: ProviderKind;
              model: string | null;
              cwd: string;
              title: string;
              created_at: number;
              updated_at: number;
              archived_at: number | null;
              resume_token: string | null;
              worktree: number;
            },
            []
          >("SELECT * FROM threads ORDER BY created_at")
          .all()
          .map((row) => ({
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
              worktree: row.worktree === 1,
            },
            resumeToken: row.resume_token,
          })),
      ),
      unresolvedApprovals: () => {
        const pending = new Map<string, string>();
        for (const row of selectApprovals.all()) {
          const requestId = Option.getOrUndefined(
            Schema.decodeUnknownOption(
              Schema.fromJsonString(Schema.Struct({ requestId: Schema.String })),
            )(row.json),
          )?.requestId;
          if (requestId === undefined) continue;
          if (row.kind === "approval.requested") pending.set(requestId, row.thread_id);
          else pending.delete(requestId);
        }
        return [...pending];
      },
      firstUserMessage: (threadId) => {
        const row = selectFirstUser.get({ threadId });
        if (!row) return null;
        return (
          Option.getOrUndefined(
            Schema.decodeUnknownOption(
              Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
            )(row.json),
          )?.text ?? null
        );
      },
      cursor: (threadId) => selectCursor.get({ threadId })?.seq ?? 0,
      measureAfter: (threadId, after) => {
        const row = selectMeasure.get({ threadId, after });
        return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
      },
      readAfter: (threadId, after) => toStored(selectAfter.all({ threadId, after })),
      readTurns: (threadId, turnLimit, before = Number.MAX_SAFE_INTEGER) => {
        const start = selectTurnStart.get({ threadId, before, offset: Math.max(0, turnLimit - 1) });
        const from = start?.seq ?? 0;
        const events = toStored(selectRange.all({ threadId, from, before }));
        if (events.length === 0) return { events, page: null };
        const hasMore = start !== null && selectOlder.get({ threadId, before: from }) !== null;
        return { events, page: { before: events[0]!.id, hasMore } };
      },
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
          worktree: info.worktree ? 1 : 0,
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
        const seq = Number(
          appendEvent.run({ threadId, kind: event._tag, json: JSON.stringify(event) })
            .lastInsertRowid,
        );
        if (RuntimeEvent.isAnyOf(["user.message", "assistant.completed"])(event) && event.text) {
          const sender = RuntimeEvent.guards["user.message"](event) ? "user" : "assistant";
          indexMessage.run({ text: event.text, threadId, messageId: event.messageId, sender, seq });
        }
        return seq;
      },
      findUserMessage: (threadId, messageId) => {
        const messages = toStored(selectUserMessages.all({ threadId })).flatMap(({ id, event }) =>
          RuntimeEvent.guards["user.message"](event) ? [{ seq: id, event }] : [],
        );
        const index = messages.findIndex((m) => m.event.messageId === messageId);
        if (index === -1) return null;
        return {
          seq: messages[index]!.seq,
          event: messages[index]!.event,
          before: index,
          from: messages.slice(index).map((m) => m.event),
        };
      },
      truncate: (threadId, seq) => {
        db.transaction(() => {
          truncateEvents.run({ threadId, seq });
          truncateIndex.run({ threadId, seq });
        })();
      },
      search: (query, limit) => {
        // Each word prefix-matches; quoting keeps FTS syntax in the query from being interpreted.
        const terms = query
          .split(/\s+/)
          .filter(Boolean)
          .map((word) => `"${word.replaceAll('"', '""')}"*`);
        if (!terms.length) return [];
        return selectSearch.all({ query: terms.join(" "), limit }).map((row) => ({
          threadId: row.thread_id,
          messageId: row.message_id,
          from: row.sender,
          snippet: row.snippet,
        }));
      },
      deleteThread: (id) => {
        db.transaction(() => {
          deleteThread.run({ id });
          deleteIndex.run({ threadId: id });
        })();
      },
    });
  }),
);

export const layer = Layer.effect(ThreadStore, make);
