import {
  isTranscriptEvent,
  RuntimeEvent,
  type PageInfo,
  LimitStop,
  ProviderKind,
  QueuedMessage,
  type SearchHit,
  type StoredEvent,
  type ThreadInfo,
  ThreadUsage,
} from "@masscode/contracts";
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
  readonly isWorktree: boolean;
}

/** Per harness, the conversation id to resume it from. */
const ResumeTokens = Schema.Record(ProviderKind, Schema.optionalKey(Schema.String));
export type ResumeTokens = typeof ResumeTokens.Type;

/**
 * Per harness not caught up on the thread, the stored event id its own conversation goes up
 * to; 0 for one that has none. The harness in use is missing unless it has a handoff coming.
 */
const Coverage = Schema.Record(ProviderKind, Schema.optionalKey(Schema.Number));
export type Coverage = typeof Coverage.Type;

interface StoredThread {
  readonly info: ThreadInfo;
  readonly home: ThreadHome;
  readonly resumeTokens: ResumeTokens;
  readonly coverage: Coverage;
  readonly shelveOverride: ShelveOverride;
  readonly queue: ReadonlyArray<QueuedMessage>;
}

type UserMessage = Extract<RuntimeEvent, { _tag: "user.message" }>;

interface EventRow {
  readonly seq: number;
  readonly json: string;
}

interface ThreadRow {
  readonly id: string;
  readonly project_id: string;
  readonly provider: ProviderKind;
  readonly model: string | null;
  readonly cwd: string;
  readonly agent_cwd: string | null;
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly archived_at: number | null;
  readonly resume_token: string | null;
  readonly resume_tokens: string | null;
  readonly coverage: string | null;
  readonly worktree: number;
  readonly usage: string | null;
  readonly seen_rev: number;
  readonly shelve_override: ShelveOverride;
  readonly started_by: string | null;
  readonly queue: string | null;
  readonly limit_stop: string | null;
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
    readonly listUnresolvedApprovals: () => ReadonlyArray<readonly [string, string]>;
    /** Turns that started and never ended (the daemon died during them), by the message that started each. */
    readonly listUnfinishedTurns: () => ReadonlyArray<{
      readonly threadId: string;
      readonly messageId: string;
    }>;
    readonly hasMessage: (threadId: string, messageId: string) => boolean;
    readonly readFirstUserMessage: (threadId: string) => string | null;
    /** Newest stored event id of a thread; 0 if none. */
    readonly readCursor: (threadId: string) => number;
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
      readonly event: UserMessage;
      /** User messages before it. */
      readonly before: number;
      readonly from: ReadonlyArray<UserMessage>;
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
      readonly from: ReadonlyArray<UserMessage>;
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
>()("masscode/ThreadStore") {}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeEvent));
const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadUsage));
const decodeQueue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(QueuedMessage)));
const decodeLimitStop = Schema.decodeUnknownOption(Schema.fromJsonString(LimitStop));

const decodeTag = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.optional(Schema.String) })),
);
const decodeRequestId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ requestId: Schema.String })),
);
const decodeText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

const decodeTokens = Schema.decodeUnknownOption(Schema.fromJsonString(ResumeTokens));
const decodeCoverage = Schema.decodeUnknownOption(Schema.fromJsonString(Coverage));

/** Per-harness tokens, with the one stored before there were several counted for the thread's harness. */
function parseResumeTokens(
  row: Pick<ThreadRow, "provider" | "resume_token" | "resume_tokens">,
): ResumeTokens {
  const tokens: ResumeTokens =
    row.resume_tokens === null ? {} : Option.getOrElse(decodeTokens(row.resume_tokens), () => ({}));
  return row.resume_token === null || tokens[row.provider] !== undefined
    ? tokens
    : { ...tokens, [row.provider]: row.resume_token };
}

/** Brings a database from any earlier version up to this one's tables and columns. */
function migrate(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resume_token TEXT
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id)");

  // The event's tag as a column, so turns and approvals are found without decoding every row.
  const eventColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(events)")
      .all()
      .map((column) => column.name),
  );
  if (!eventColumns.has("kind")) database.run("ALTER TABLE events ADD COLUMN kind TEXT");

  const untagged = database
    .query<EventRow, []>("SELECT seq, json FROM events WHERE kind IS NULL")
    .all();
  if (untagged.length) {
    const setKind = database.prepare("UPDATE events SET kind = $kind WHERE seq = $seq");
    database.transaction(() => {
      for (const row of untagged)
        setKind.run({
          seq: row.seq,
          kind: Option.getOrUndefined(decodeTag(row.json))?._tag ?? "",
        });
    })();
  }

  database.run("CREATE INDEX IF NOT EXISTS events_thread_kind ON events(thread_id, kind, seq)");
  database.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('data_id', $id)").run({
    id: crypto.randomUUID(),
  });

  // Migrations for databases created before a column existed.
  const columns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(threads)")
      .all()
      .map((column) => column.name),
  );
  if (!columns.has("model")) database.run("ALTER TABLE threads ADD COLUMN model TEXT");
  if (!columns.has("archived_at"))
    database.run("ALTER TABLE threads ADD COLUMN archived_at INTEGER");
  if (!columns.has("updated_at")) {
    database.run("ALTER TABLE threads ADD COLUMN updated_at INTEGER");
    database.run("UPDATE threads SET updated_at = created_at");
  }
  if (!columns.has("worktree"))
    database.run("ALTER TABLE threads ADD COLUMN worktree INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("agent_cwd")) database.run("ALTER TABLE threads ADD COLUMN agent_cwd TEXT");
  if (!columns.has("usage")) database.run("ALTER TABLE threads ADD COLUMN usage TEXT");
  if (!columns.has("seen_rev")) {
    database.run("ALTER TABLE threads ADD COLUMN seen_rev INTEGER NOT NULL DEFAULT 0");
    // Threads from before the daemon tracked this count as looked at.
    database.run("UPDATE threads SET seen_rev = updated_at");
  }
  if (!columns.has("shelve_override"))
    database.run("ALTER TABLE threads ADD COLUMN shelve_override TEXT");
  if (!columns.has("started_by")) database.run("ALTER TABLE threads ADD COLUMN started_by TEXT");
  if (!columns.has("queue")) database.run("ALTER TABLE threads ADD COLUMN queue TEXT");
  if (!columns.has("limit_stop")) database.run("ALTER TABLE threads ADD COLUMN limit_stop TEXT");
  // Per-harness tokens replace `resume_token`, which is emptied once they're written.
  if (!columns.has("resume_tokens"))
    database.run("ALTER TABLE threads ADD COLUMN resume_tokens TEXT");
  if (!columns.has("coverage")) database.run("ALTER TABLE threads ADD COLUMN coverage TEXT");
  if (columns.has("settle_override")) {
    // Shelving was called settling. Both columns can exist, so a newer shelve value wins.
    database.run(
      "UPDATE threads SET shelve_override = CASE settle_override WHEN 'settled' THEN 'shelved' ELSE settle_override END WHERE shelve_override IS NULL",
    );
    database.run("ALTER TABLE threads DROP COLUMN settle_override");
  }

  // Full-text index of what was said, for search. Filled as messages are stored; built from the log once.
  const hasSearch =
    database.query("SELECT name FROM sqlite_master WHERE name = 'messages_fts'").get() !== null;
  if (!hasSearch) {
    database.run(
      `CREATE VIRTUAL TABLE messages_fts USING fts5(text, thread_id UNINDEXED, message_id UNINDEXED, sender UNINDEXED, seq UNINDEXED, tokenize = "unicode61 remove_diacritics 2")`,
    );
    database.run(`INSERT INTO messages_fts (text, thread_id, message_id, sender, seq)
      SELECT json_extract(json, '$.text'), thread_id, json_extract(json, '$.messageId'),
        CASE kind WHEN 'user.message' THEN 'user' ELSE 'assistant' END, seq
      FROM events WHERE kind IN ('user.message', 'assistant.completed') AND json_extract(json, '$.text') != ''`);
  }
}

const make = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => {
      mkdirSync(DATA_DIR, { recursive: true });
      const database = new Database(join(DATA_DIR, "masscode.db"), { create: true, strict: true });
      database.run("PRAGMA journal_mode = WAL");
      // With WAL, NORMAL only fsyncs at checkpoints: still safe against corruption, much cheaper per append.
      database.run("PRAGMA synchronous = NORMAL");
      database.run("PRAGMA busy_timeout = 5000");
      database.run("PRAGMA foreign_keys = ON");
      migrate(database);
      return database;
    }),
    (database) => Effect.sync(() => database.close()),
  );

  const insertThread = database.prepare(
    "INSERT INTO threads (id, project_id, provider, model, cwd, agent_cwd, title, created_at, updated_at, worktree, started_by) VALUES ($id, $projectId, $provider, $model, $cwd, $agentCwd, $title, $createdAt, $updatedAt, $worktree, $startedBy)",
  );
  const setAgentCwd = database.prepare("UPDATE threads SET agent_cwd = $cwd WHERE id = $id");
  const setMeta = database.prepare(
    "UPDATE threads SET title = $title, updated_at = $updatedAt WHERE id = $id",
  );
  const setModel = database.prepare("UPDATE threads SET model = $model WHERE id = $id");
  const setQueue = database.prepare("UPDATE threads SET queue = $queue WHERE id = $id");
  const setLimitStop = database.prepare(
    "UPDATE threads SET limit_stop = $limitStop WHERE id = $id",
  );
  // A turn starts at a user message not sent into a running one, and ends at turn.completed.
  const selectUnfinished = database.prepare<{ thread_id: string; message_id: string }, []>(
    `SELECT thread_id, (SELECT json_extract(json, '$.messageId') FROM events WHERE seq = turn_seq) AS message_id
     FROM (
       SELECT thread_id,
         MAX(CASE WHEN kind = 'user.message' AND COALESCE(json_extract(json, '$.steer'), 0) = 0 THEN seq END) AS turn_seq,
         MAX(CASE WHEN kind = 'turn.completed' THEN seq END) AS done_seq
       FROM events WHERE kind IN ('user.message', 'turn.completed') GROUP BY thread_id
     ) WHERE turn_seq > COALESCE(done_seq, 0)`,
  );
  const setUsage = database.prepare("UPDATE threads SET usage = $usage WHERE id = $id");
  const setArchived = database.prepare(
    "UPDATE threads SET archived_at = $archivedAt WHERE id = $id",
  );
  const setSeenRev = database.prepare("UPDATE threads SET seen_rev = $seenRev WHERE id = $id");
  const setShelveOverride = database.prepare(
    "UPDATE threads SET shelve_override = $override WHERE id = $id",
  );
  const setResumeTokens = database.prepare(
    "UPDATE threads SET resume_tokens = $tokens, resume_token = NULL WHERE id = $id",
  );
  const setCoverage = database.prepare("UPDATE threads SET coverage = $coverage WHERE id = $id");
  const setProvider = database.prepare(
    "UPDATE threads SET provider = $provider, model = $model WHERE id = $id",
  );
  const tagUserMessages = database.prepare(
    "UPDATE events SET json = json_set(json, '$.provider', $provider) WHERE thread_id = $threadId AND kind = 'user.message' AND json_extract(json, '$.provider') IS NULL",
  );
  const appendEvent = database.prepare(
    "INSERT INTO events (thread_id, kind, json) VALUES ($threadId, $kind, $json)",
  );
  const indexMessage = database.prepare(
    "INSERT INTO messages_fts (text, thread_id, message_id, sender, seq) VALUES ($text, $threadId, $messageId, $sender, $seq)",
  );
  const selectUserMessages = database.prepare<EventRow, { threadId: string }>(
    "SELECT seq, json FROM events WHERE thread_id = $threadId AND kind = 'user.message' ORDER BY seq",
  );
  const selectMessageSeq = database.prepare<
    { seq: number },
    { threadId: string; messageId: string }
  >(
    "SELECT seq FROM events WHERE thread_id = $threadId AND json_extract(json, '$.messageId') = $messageId ORDER BY seq LIMIT 1",
  );
  const copyEvents = database.prepare(
    "INSERT INTO events (thread_id, kind, json) SELECT $to, kind, json_set(json, '$.threadId', $to) FROM events WHERE thread_id = $from AND seq < $before ORDER BY seq",
  );
  const indexThread = database.prepare(
    `INSERT INTO messages_fts (text, thread_id, message_id, sender, seq)
      SELECT json_extract(json, '$.text'), thread_id, json_extract(json, '$.messageId'),
        CASE kind WHEN 'user.message' THEN 'user' ELSE 'assistant' END, seq
      FROM events WHERE thread_id = $threadId AND kind IN ('user.message', 'assistant.completed') AND json_extract(json, '$.text') != ''`,
  );
  const truncateEvents = database.prepare(
    "DELETE FROM events WHERE thread_id = $threadId AND seq >= $seq",
  );
  const truncateIndex = database.prepare(
    "DELETE FROM messages_fts WHERE thread_id = $threadId AND seq >= $seq",
  );
  const deleteIndex = database.prepare("DELETE FROM messages_fts WHERE thread_id = $threadId");
  const selectSearch = database.prepare<
    { thread_id: string; message_id: string; sender: "user" | "assistant"; snippet: string },
    { query: string; limit: number }
  >(
    `SELECT thread_id, message_id, sender, snippet(messages_fts, 0, char(57344), char(57345), '…', 16) AS snippet
     FROM messages_fts WHERE messages_fts MATCH $query ORDER BY seq DESC LIMIT $limit`,
  );
  const dataId = database
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'data_id'")
    .get()!.value;

  function toStoredEvents(rows: ReadonlyArray<EventRow>): Array<StoredEvent> {
    return rows.flatMap((row) =>
      Option.match(decodeEvent(row.json), {
        onNone: () => [],
        onSome: (event) => [{ id: row.seq, event }],
      }),
    );
  }

  function readUserMessages(threadId: string) {
    return toStoredEvents(selectUserMessages.all({ threadId })).flatMap(({ id, event }) =>
      RuntimeEvent.guards["user.message"](event) ? [{ seq: id, event }] : [],
    );
  }

  const selectAfter = database.prepare<EventRow, { threadId: string; after: number }>(
    "SELECT seq, json FROM events WHERE thread_id = $threadId AND seq > $after ORDER BY seq",
  );
  const selectMeasure = database.prepare<
    { count: number; bytes: number | null },
    { threadId: string; after: number }
  >(
    "SELECT COUNT(*) AS count, SUM(length(CAST(json AS BLOB))) AS bytes FROM events WHERE thread_id = $threadId AND seq > $after",
  );
  const selectRange = database.prepare<
    EventRow,
    { threadId: string; from: number; before: number }
  >(
    "SELECT seq, json FROM events WHERE thread_id = $threadId AND seq >= $from AND seq < $before ORDER BY seq",
  );
  const selectTurnStart = database.prepare<
    { seq: number },
    { threadId: string; before: number; offset: number }
  >(
    "SELECT seq FROM events WHERE thread_id = $threadId AND kind = 'user.message' AND seq < $before ORDER BY seq DESC LIMIT 1 OFFSET $offset",
  );
  const selectOlder = database.prepare<{ seq: number }, { threadId: string; before: number }>(
    "SELECT seq FROM events WHERE thread_id = $threadId AND seq < $before LIMIT 1",
  );
  const selectCursor = database.prepare<{ seq: number | null }, { threadId: string }>(
    "SELECT MAX(seq) AS seq FROM events WHERE thread_id = $threadId",
  );
  const selectApprovals = database.prepare<{ thread_id: string; kind: string; json: string }, []>(
    "SELECT thread_id, kind, json FROM events WHERE kind IN ('approval.requested', 'approval.resolved') ORDER BY seq",
  );
  const selectFirstUser = database.prepare<{ json: string }, { threadId: string }>(
    "SELECT json FROM events WHERE thread_id = $threadId AND kind = 'user.message' ORDER BY seq LIMIT 1",
  );
  const deleteThread = database.prepare("DELETE FROM threads WHERE id = $id");

  return ThreadStore.of({
    dataId,
    load: Effect.sync(() =>
      database
        .query<ThreadRow, []>("SELECT * FROM threads ORDER BY created_at")
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
          home: { path: row.cwd, isWorktree: row.worktree === 1 },
          resumeTokens: parseResumeTokens(row),
          coverage:
            row.coverage === null ? {} : Option.getOrElse(decodeCoverage(row.coverage), () => ({})),
          shelveOverride: row.shelve_override,
          queue: row.queue === null ? [] : Option.getOrElse(decodeQueue(row.queue), () => []),
        })),
    ),
    listUnresolvedApprovals: () => {
      const pending = new Map<string, string>();
      for (const row of selectApprovals.all()) {
        const requestId = Option.getOrUndefined(decodeRequestId(row.json))?.requestId;
        if (requestId === undefined) continue;

        if (row.kind === "approval.requested") pending.set(requestId, row.thread_id);
        else pending.delete(requestId);
      }
      return [...pending];
    },
    listUnfinishedTurns: () =>
      selectUnfinished.all().map((row) => ({ threadId: row.thread_id, messageId: row.message_id })),
    hasMessage: (threadId, messageId) => selectMessageSeq.get({ threadId, messageId }) !== null,
    readFirstUserMessage: (threadId) => {
      const row = selectFirstUser.get({ threadId });
      if (!row) return null;

      return Option.getOrUndefined(decodeText(row.json))?.text ?? null;
    },
    readCursor: (threadId) => selectCursor.get({ threadId })?.seq ?? 0,
    measureAfter: (threadId, after) => {
      const row = selectMeasure.get({ threadId, after });
      return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
    },
    readAfter: (threadId, after) => toStoredEvents(selectAfter.all({ threadId, after })),
    readTurns: (threadId, turnLimit, before = Number.MAX_SAFE_INTEGER) => {
      const start = selectTurnStart.get({ threadId, before, offset: Math.max(0, turnLimit - 1) });
      const from = start?.seq ?? 0;
      const events = toStoredEvents(selectRange.all({ threadId, from, before }));
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
        worktree: home.isWorktree ? 1 : 0,
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
      const messages = readUserMessages(threadId);
      const index = messages.findIndex((message) => message.event.messageId === messageId);
      const found = messages[index];
      if (!found) return null;

      return {
        seq: found.seq,
        event: found.event,
        before: index,
        from: messages.slice(index).map((message) => message.event),
      };
    },
    findTurnsAfter: (threadId, messageId) => {
      const after = selectMessageSeq.get({ threadId, messageId });
      if (!after) return null;

      const messages = readUserMessages(threadId);
      const index = messages.findIndex(
        (message) => message.seq > after.seq && !message.event.steer,
      );
      const found = messages[index];
      if (!found) return { seq: null, before: messages.length, from: [] };

      return {
        seq: found.seq,
        before: index,
        from: messages.slice(index).map((message) => message.event),
      };
    },
    copyEvents: (from, to, before) => {
      database.transaction(() => {
        copyEvents.run({ from, to, before: before ?? Number.MAX_SAFE_INTEGER });
        indexThread.run({ threadId: to });
      })();
    },
    truncate: (threadId, seq) => {
      database.transaction(() => {
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
      database.transaction(() => {
        deleteThread.run({ id });
        deleteIndex.run({ threadId: id });
      })();
    },
  });
});

export const layer = Layer.effect(ThreadStore, make);
