import { RuntimeEvent, type ThreadInfo } from "@masscode/contracts";

type Threads = Readonly<Record<string, ThreadInfo>>;

/** Applies an event that changes one thread's row (status, title, pending request…); any other leaves `threads` as is. */
export function reduceThreads(threads: Threads, event: RuntimeEvent): Threads {
  function update(threadId: string, change: (info: ThreadInfo) => ThreadInfo): Threads {
    const info = threads[threadId];

    return info ? { ...threads, [threadId]: change(info) } : threads;
  }

  return RuntimeEvent.matchOrElse<Threads>(
    event,
    {
      "thread.status": ({ threadId, status }) => update(threadId, (info) => ({ ...info, status })),
      "thread.model": ({ threadId, provider, model }) =>
        update(threadId, (info) => ({ ...info, provider, model })),
      "thread.archived": ({ threadId, archivedAt }) =>
        update(threadId, (info) => ({ ...info, archivedAt })),
      "thread.shelved": ({ threadId, shelved }) =>
        update(threadId, (info) => ({ ...info, shelved })),
      "thread.seen": ({ threadId, seenRev }) => update(threadId, (info) => ({ ...info, seenRev })),
      "thread.activity": ({ threadId, activity }) =>
        update(threadId, (info) => ({ ...info, activity: activity ?? undefined })),
      "thread.request": ({ threadId, request }) =>
        update(threadId, (info) => ({ ...info, request: request ?? undefined })),
      "thread.limitStop": ({ threadId, limitStop }) =>
        update(threadId, (info) => ({ ...info, limitStop: limitStop ?? undefined })),
      "thread.queue": ({ threadId, queue }) =>
        update(threadId, (info) => ({ ...info, queue: queue.length > 0 ? queue : undefined })),
      "thread.meta": ({ threadId, title, updatedAt, branch, cwd, worktree }) =>
        update(threadId, (info) => ({ ...info, title, updatedAt, branch, cwd, worktree })),
    },
    () => threads,
  );
}
