import { ClientCommand, ServerFrame } from "@masscode/contracts";
import { getHttpOrigin, request } from "@/shared/api";
import { transcriptKey, useThreadStore } from "../model/thread-store.ts";

/** Signed URLs by `transcriptKey` and path, renewed before the host's hour runs out. */
const signedImages = new Map<
  string,
  { readonly url: Promise<string | null>; readonly signedAtMs: number }
>();

/** A URL `<Image>` can load for an image file on the thread's host; null when it can't be shown now. */
export function fetchImageUrl(hostId: string, threadId: string, path: string) {
  const key = `${transcriptKey(hostId, threadId)}\n${path}`;
  const cached = signedImages.get(key);

  if (cached && Date.now() - cached.signedAtMs < 50 * 60 * 1000) return cached.url;

  const origin = getHttpOrigin(hostId);
  const thread = useThreadStore.getState().threads[hostId]?.[threadId];

  if (origin === null || !thread) return Promise.resolve(null);

  const url = new Promise<string | null>((resolve) => {
    request(
      hostId,
      (requestId) => ClientCommand.cases["image.sign"].make({ path, cwd: thread.cwd, requestId }),
      (reply) => resolve(ServerFrame.guards["image.signed"](reply) ? reply.url : null),
      () => resolve(null),
    );
  }).then((signed) => {
    if (!signed) {
      signedImages.delete(key);

      return null;
    }

    // The socket's address, MagicDNS name or Tailscale IP, is the one that worked just now.
    return new URL(signed, origin).href;
  });

  signedImages.set(key, { url, signedAtMs: Date.now() });

  return url;
}
