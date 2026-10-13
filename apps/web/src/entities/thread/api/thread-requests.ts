import { ClientCommand, type SearchHit } from "@masscode/contracts";
import { getConnectionHttpUrl, listDaemonHosts, sendRequest } from "@/shared/api";
import { getThreadHost, getThreadState } from "../model/thread-store.ts";

/** Signed URLs by thread and source, renewed before the daemon's hour runs out. */
const signedImages = new Map<
  string,
  { readonly url: Promise<string | null>; readonly signedAtMs: number }
>();

/** A URL `<img>` can load for an image file on the thread's host; null when there's no such image. */
export function fetchImageUrl(threadId: string, src: string) {
  const key = `${threadId}\n${src}`;
  const cached = signedImages.get(key);

  if (cached && Date.now() - cached.signedAtMs < 50 * 60 * 1000) return cached.url;

  const thread = getThreadState().threads[threadId];
  const host = getThreadHost(threadId);

  const url = thread
    ? sendRequest(
        host,
        ClientCommand.cases["image.sign"].make({
          path: decodeURI(src.replace(/^file:\/\//, "")),
          cwd: thread.cwd,
          requestId: crypto.randomUUID(),
        }),
        "image.signed",
        10_000,
      ).then((signed) => {
        const base = getConnectionHttpUrl(host);

        if (!signed?.url || !base) {
          signedImages.delete(key);

          return null;
        }

        // Remote hosts are reached through a tunnel on this Mac, so the socket's address serves both.
        return new URL(signed.url, base).href;
      })
    : Promise.resolve(null);

  signedImages.set(key, { url, signedAtMs: Date.now() });

  return url;
}

/** Full-text search over every thread's messages, newest first. */
export async function searchMessages(query: string): Promise<ReadonlyArray<SearchHit>> {
  const answers = await Promise.all(
    listDaemonHosts().map((host) =>
      sendRequest(
        host,
        ClientCommand.cases.search.make({ query, requestId: crypto.randomUUID() }),
        "search.results",
        // An answer that never comes (the connection dropped) shouldn't hold a caller forever.
        5000,
      ),
    ),
  );

  return answers.flatMap((answer) => answer?.hits ?? []);
}
