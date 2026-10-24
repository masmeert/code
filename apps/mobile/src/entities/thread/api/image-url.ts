import { ClientCommand, ServerFrame } from "@masscode/contracts";
import { File, Paths } from "expo-file-system";
import { getHttpOrigin, isThroughRelay, request } from "@/shared/api";
import { transcriptKey, useThreadStore } from "../model/thread-store.ts";

/** The host's answer to a request; null when the connection closed first. */
function ask(hostId: string, build: (requestId: string) => ClientCommand) {
  return new Promise<ServerFrame | null>((resolve) => {
    request(hostId, build, resolve, () => resolve(null));
  });
}

/** Through the relay nothing loads over HTTP, so the image comes over the session into a cache file. */
async function downloadThroughRelay(hostId: string, signed: string, path: string) {
  const reply = await ask(hostId, (requestId) =>
    ClientCommand.cases["asset.read"].make({ url: signed, requestId }),
  );

  if (!reply || !ServerFrame.guards["asset.data"](reply) || reply.data === null) return null;

  const file = new File(Paths.cache, `${crypto.randomUUID()}-${path.split("/").at(-1)}`);
  file.write(reply.data, { encoding: "base64" });

  return file.uri;
}

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

  if ((origin === null && !isThroughRelay(hostId)) || !thread) return Promise.resolve(null);

  const url = ask(hostId, (requestId) =>
    ClientCommand.cases["image.sign"].make({ path, cwd: thread.cwd, requestId }),
  )
    .then((reply) => {
      const signed = reply && ServerFrame.guards["image.signed"](reply) ? reply.url : null;

      if (!signed) return null;

      // The socket's address, MagicDNS name or Tailscale IP, is the one that worked just now.
      return origin ? new URL(signed, origin).href : downloadThroughRelay(hostId, signed, path);
    })
    .then((resolved) => {
      if (!resolved) signedImages.delete(key);

      return resolved;
    });

  signedImages.set(key, { url, signedAtMs: Date.now() });

  return url;
}
