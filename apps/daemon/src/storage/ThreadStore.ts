import {
  isTranscriptEvent,
  RuntimeEvent,
  type PageInfo,
  LimitStop,
  type ProviderKind,
  QueuedMessage,
  type SearchHit,
  type StoredEvent,
  type ThreadInfo,
  ThreadUsage,
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

/** A Shelve/Unshelve from the thread menu, kept until the thread's next turn starts. */
export type ShelveOverride = "shelved" | "active" | null;

/** The folder a thread's agent starts in. Claude moves back into a worktree it switched to on resume, so resumes launch here too. */
export interface ThreadHome {
  readonly path: string;
  /** A worktree made for the thread, removed with it when it has no changes. */
  readonly worktree: boolean;
}

/** Per harness, the conversation id to resume it from. */
export type ResumeTokens = Partial<Record<ProviderKind, string>>;

/**
 * Per harness not caught up on the thread, the stored event id its own conversation goes up
 * to; 0 for one that has none. The harness in use is missing unless it has a handoff coming.
 */
export type Coverage = Partial<Record<ProviderKind, number>>;

export interface StoredThread {
  readonly info: ThreadInfo;
  readonly home: ThreadHome;
  readonly resumeTokens: ResumeTokens;
  readonly coverage: Coverage;
  readonly shelveOverride: ShelveOverride;
  readonly queue: ReadonlyArray<QueuedMessage>;
}

/** Events worth replaying after a restart: the transcript, with deltas folded into `assistant.completed`. */
export function isPersisted(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { threadId: string }> {
  return (
    isTranscriptEvent(event) &&
    !RuntimeEvent.isAnyOf(["assistant.delta", "reasoning.delta", "tool.progress"])(event)
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
    /** Turns that started and never ended (the daemon died during them), by the message that started each. */
    readonly unfinishedTurns: () => ReadonlyArray<{
      readonly threadId: string;
      readonly messageId: string;
    }>;
    readonly hasMessage: (threadId: string, messageId: string) => boolean;
    readonly firstUserMessage: (threadId: string) => string | null;
    /** The thread's messages, user and assistant, oldest first; tool calls and the rest left out. */
    readonly readMessages: (
      threadId: string,
    ) => ReadonlyArray<Extract<RuntimeEvent, { _tag: "user.message" | "assistant.completed" }>>;
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
    readonly insertThread: (info: ThreadInfo, home: ThreadHome) => void;
    /** Null puts the agent back in its home folder. */
    readonly setAgentCwd: (threadId: string, cwd: string | null) => void;
    /** A harness missing from them starts its conversation over on its next message. */
    readonly setResumeTokens: (threadId: string, tokens: ResumeTokens) => void;
    readonly setCoverage: (threadId: string, coverage: Coverage) => void;
    readonly setProvider: (threadId: string, provider: ProviderKind, model: string | null) => void;
    /** Marks the thread's user messages that don't say which harness they went to as `provider`'s. */
    readonly tagUserMessages: (threadId: string, provider: ProviderKind) => void;
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
    /**
     * Where the turns after message `messageId` (of any kind) start: the first user message
     * not sent mid-turn, null when that message's turn is the last.
     */
    readonly findTurnsAfter: (
      threadId: string,
      messageId: string,
    ) => {
      readonly seq: number | null;
      /** User messages before it. */
      readonly before: number;
      readonly from: ReadonlyArray<Extract<RuntimeEvent, { _tag: "user.message" }>>;
    } | null;
    /** Copies a thread's events before id `before` (all of them when null) to another thread. */
    readonly copyEvents: (fromThreadId: string, toThreadId: string, before: number | null) => void;
    /** Deletes the thread's events from id `seq` on. */
    readonly truncate: (threadId: string, seq: number) => void;
    /** Messages matching `query` (words, prefix-matched), newest first. */
    readonly search: (query: string, limit: number) => ReadonlyArray<SearchHit>;
    readonly setModel: (threadId: string, model: string | null) => void;
    readonly setQueue: (threadId: string, queue: ReadonlyArray<QueuedMessage>) => void;
    readonly setLimitStop: (threadId: string, limitStop: LimitStop | null) => void;
    readonly setUsage: (threadId: string, usage: ThreadUsage) => void;
    readonly setArchived: (threadId: string, archivedAt: number | null) => void;
    readonly setSeenRev: (threadId: string, seenRev: number) => void;
    readonly setShelveOverride: (threadId: string, override: ShelveOverride) => void;
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
const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadUsage));
const decodeQueue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(QueuedMessage)));
const decodeLimitStop = Schema.decodeUnknownOption(Schema.fromJsonString(LimitStop));
const decodeTokens = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      claude: Schema.optionalKey(Schema.String),
      codex: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeCoverage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      claude: Schema.optionalKey(Schema.Number),
      codex: Schema.optionalKey(Schema.Number),
    }),
  ),
);

/** Per-harness tokens, with the one stored before there were several counted for the thread's harness. */
function legacyTokens(row: {
  readonly provider: ProviderKind;
  readonly resume_token: string | null;
  readonly resume_tokens: string | null;
}): ResumeTokens {
  const tokens: ResumeTokens =
    row.resume_tokens === null ? {} : Option.getOrElse(decodeTokens(row.resume_tokens), () => ({}));
  if (row.resume_token !== null) tokens[row.provider] ??= row.resume_token;
  return tokens;
}

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
    if (!columns.has("agent_cwd")) db.run("ALTER TABLE threads ADD COLUMN agent_cwd TEXT");
    if (!columns.has("usage")) db.run("ALTER TABLE threads ADD COLUMN usage TEXT");
    if (!columns.has("seen_rev")) {
      db.run("ALTER TABLE threads ADD COLUMN seen_rev INTEGER NOT NULL DEFAULT 0");
      // Threads from before the daemon tracked this count as looked at.
      db.run("UPDATE threads SET seen_rev = updated_at");
    }
    if (!columns.has("shelve_override"))
      db.run("ALTER TABLE threads ADD COLUMN shelve_override TEXT");
    if (!columns.has("started_by")) db.run("ALTER TABLE threads ADD COLUMN started_by TEXT");
    if (!columns.has("queue")) db.run("ALTER TABLE threads ADD COLUMN queue TEXT");
    if (!columns.has("limit_stop")) db.run("ALTER TABLE threads ADD COLUMN limit_stop TEXT");
    // Per-harness tokens replace `resume_token`, which is emptied once they're written.
    if (!columns.has("resume_tokens")) db.run("ALTER TABLE threads ADD COLUMN resume_tokens TEXT");
    if (!columns.has("coverage")) db.run("ALTER TABLE threads ADD COLUMN coverage TEXT");
    if (columns.has("settle_override")) {
      // Shelving was called settling. Both columns can exist, so a newer shelve value wins.
      db.run(
        "UPDATE threads SET shelve_override = CASE settle_override WHEN 'settled' THEN 'shelved' ELSE settle_override END WHERE shelve_override IS NULL",
      );
      db.run("ALTER TABLE threads DROP COLUMN settle_override");
    }
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
      "INSERT INTO threads (id, project_id, provider, model, cwd, agent_cwd, title, created_at, updated_at, worktree, started_by) VALUES ($id, $projectId, $provider, $model, $cwd, $agentCwd, $title, $createdAt, $updatedAt, $worktree, $startedBy)",
    );
    const setAgentCwd = db.prepare("UPDATE threads SET agent_cwd = $cwd WHERE id = $id");
    const setMeta = db.prepare(
      "UPDATE threads SET title = $title, updated_at = $updatedAt WHERE id = $id",
    );
    const setModel = db.prepare("UPDATE threads SET model = $model WHERE id = $id");
    const setQueue = db.prepare("UPDATE threads SET queue = $queue WHERE id = $id");
    const setLimitStop = db.prepare("UPDATE threads SET limit_stop = $limitStop WHERE id = $id");
    // A turn starts at a user message not sent into a running one, and ends at turn.completed.
    const selectUnfinished = db.prepare<{ thread_id: string; message_id: string }, []>(
      `SELECT thread_id, (SELECT json_extract(json, '$.messageId') FROM events WHERE seq = turn_seq) AS message_id
       FROM (
         SELECT thread_id,
           MAX(CASE WHEN kind = 'user.message' AND COALESCE(json_extract(json, '$.steer'), 0) = 0 THEN seq END) AS turn_seq,
           MAX(CASE WHEN kind = 'turn.completed' THEN seq END) AS done_seq
         FROM events WHERE kind IN ('user.message', 'turn.completed') GROUP BY thread_id
       ) WHERE turn_seq > COALESCE(done_seq, 0)`,
    );
    const setUsage = db.prepare("UPDATE threads SET usage = $usage WHERE id = $id");
    const setArchived = db.prepare("UPDATE threads SET archived_at = $archivedAt WHERE id = $id");
    const setSeenRev = db.prepare("UPDATE threads SET seen_rev = $seenRev WHERE id = $id");
    const setShelveOverride = db.prepare(
      "UPDATE threads SET shelve_override = $override WHERE id = $id",
    );
    const setResumeTokens = db.prepare(
      "UPDATE threads SET resume_tokens = $tokens, resume_token = NULL WHERE id = $id",
    );
    const setCoverage = db.prepare("UPDATE threads SET coverage = $coverage WHERE id = $id");
    const setProvider = db.prepare(
      "UPDATE threads SET provider = $provider, model = $model WHERE id = $id",
    );
    const tagUserMessages = db.prepare(
      "UPDATE events SET json = json_set(json, '$.provider', $provider) WHERE thread_id = $threadId AND kind = 'user.message' AND json_extract(json, '$.provider') IS NULL",
    );
    const appendEvent = db.prepare(
      "INSERT INTO events (thread_id, kind, json) VALUES ($threadId, $kind, $json)",
    );
    const indexMessage = db.prepare(
      "INSERT INTO messages_fts (text, thread_id, message_id, sender, seq) VALUES ($text, $threadId, $messageId, $sender, $seq)",
    );
    const selectUserMessages = db.prepare<{ seq: number; json: string }, { threadId: string }>(
      "SELECT seq, json FROM events WHERE thread_id = $threadId AND kind = 'user.message' ORDER BY seq",
    );
    const selectMessages = db.prepare<{ seq: number; json: string }, { threadId: string }>(
      "SELECT seq, json FROM events WHERE thread_id = $threadId AND kind IN ('user.message', 'assistant.completed') ORDER BY seq",
    );
    const selectMessageSeq = db.prepare<{ seq: number }, { threadId: string; messageId: string }>(
      "SELECT seq FROM events WHERE thread_id = $threadId AND json_extract(json, '$.messageId') = $messageId ORDER BY seq LIMIT 1",
    );
    const copyEvents = db.prepare(
      "INSERT INTO events (thread_id, kind, json) SELECT $to, kind, json_set(json, '$.threadId', $to) FROM events WHERE thread_id = $from AND seq < $before ORDER BY seq",
    );
    const indexThread = db.prepare(
      `INSERT INTO messages_fts (text, thread_id, message_id, sender, seq)
        SELECT json_extract(json, '$.text'), thread_id, json_extract(json, '$.messageId'),
          CASE kind WHEN 'user.message' THEN 'user' ELSE 'assistant' END, seq
        FROM events WHERE thread_id = $threadId AND kind IN ('user.message', 'assistant.completed') AND json_extract(json, '$.text') != ''`,
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
    const userMessages = (threadId: string) =>
      toStored(selectUserMessages.all({ threadId })).flatMap(({ id, event }) =>
        RuntimeEvent.guards["user.message"](event) ? [{ seq: id, event }] : [],
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
              agent_cwd: string | null;
              title: string;
              created_at: number;
              updated_at: number;
              archived_at: number | null;
              resume_token: string | null;
              resume_tokens: string | null;
              coverage: string | null;
              worktree: number;
              usage: string | null;
              seen_rev: number;
              shelve_override: ShelveOverride;
              started_by: string | null;
              queue: string | null;
              limit_stop: string | null;
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
              cwd: row.agent_cwd ?? row.cwd,
              title: row.title,
              status: "idle" as const,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              branch: null,
              archivedAt: row.archived_at,
              worktree: row.worktree === 1 || row.agent_cwd !== null,
              usage: row.usage === null ? undefined : Option.getOrUndefined(decodeUsage(row.usage)),
              seenRev: row.seen_rev,
              shelved: false,
              ...(row.started_by !== null && { startedBy: row.started_by }),
              limitStop:
                row.limit_stop === null
                  ? undefined
                  : Option.getOrUndefined(decodeLimitStop(row.limit_stop)),
            },
            home: { path: row.cwd, worktree: row.worktree === 1 },
            resumeTokens: legacyTokens(row),
            coverage:
              row.coverage === null
                ? {}
                : Option.getOrElse(decodeCoverage(row.coverage), () => ({})),
            shelveOverride: row.shelve_override,
            queue: row.queue === null ? [] : Option.getOrElse(decodeQueue(row.queue), () => []),
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
      unfinishedTurns: () =>
        selectUnfinished
          .all()
          .map((row) => ({ threadId: row.thread_id, messageId: row.message_id })),
      hasMessage: (threadId, messageId) => selectMessageSeq.get({ threadId, messageId }) !== null,
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
      readMessages: (threadId) =>
        toStored(selectMessages.all({ threadId })).flatMap(({ event }) =>
          RuntimeEvent.isAnyOf(["user.message", "assistant.completed"])(event) ? [event] : [],
        ),
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
      insertThread: (info, home) => {
        insertThread.run({
          id: info.id,
          projectId: info.projectId,
          provider: info.provider,
          model: info.model,
          cwd: home.path,
          agentCwd: info.cwd === home.path ? null : info.cwd,
          title: info.title,
          createdAt: info.createdAt,
          updatedAt: info.updatedAt,
          worktree: home.worktree ? 1 : 0,
          startedBy: info.startedBy ?? null,
        });
      },
      setAgentCwd: (id, cwd) => {
        setAgentCwd.run({ id, cwd });
      },
      setResumeTokens: (id, tokens) => {
        setResumeTokens.run({ id, tokens: JSON.stringify(tokens) });
      },
      setCoverage: (id, coverage) => {
        setCoverage.run({ id, coverage: JSON.stringify(coverage) });
      },
      setProvider: (id, provider, model) => {
        setProvider.run({ id, provider, model });
      },
      tagUserMessages: (threadId, provider) => {
        tagUserMessages.run({ threadId, provider });
      },
      setArchived: (id, archivedAt) => {
        setArchived.run({ id, archivedAt });
      },
      setSeenRev: (id, seenRev) => {
        setSeenRev.run({ id, seenRev });
      },
      setShelveOverride: (id, override) => {
        setShelveOverride.run({ id, override });
      },
      setModel: (id, model) => {
        setModel.run({ id, model });
      },
      setQueue: (id, queue) => {
        setQueue.run({ id, queue: queue.length ? JSON.stringify(queue) : null });
      },
      setLimitStop: (id, limitStop) => {
        setLimitStop.run({ id, limitStop: limitStop && JSON.stringify(limitStop) });
      },
      setUsage: (id, usage) => {
        setUsage.run({ id, usage: JSON.stringify(usage) });
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
        const messages = userMessages(threadId);
        const index = messages.findIndex((m) => m.event.messageId === messageId);
        if (index === -1) return null;
        return {
          seq: messages[index]!.seq,
          event: messages[index]!.event,
          before: index,
          from: messages.slice(index).map((m) => m.event),
        };
      },
      findTurnsAfter: (threadId, messageId) => {
        const after = selectMessageSeq.get({ threadId, messageId });
        if (!after) return null;
        const messages = userMessages(threadId);
        const index = messages.findIndex((m) => m.seq > after.seq && !m.event.steer);
        if (index === -1) return { seq: null, before: messages.length, from: [] };
        return {
          seq: messages[index]!.seq,
          before: index,
          from: messages.slice(index).map((m) => m.event),
        };
      },
      copyEvents: (from, to, before) => {
        db.transaction(() => {
          copyEvents.run({ from, to, before: before ?? Number.MAX_SAFE_INTEGER });
          indexThread.run({ threadId: to });
        })();
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
