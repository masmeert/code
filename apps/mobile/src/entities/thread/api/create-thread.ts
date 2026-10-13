import { ClientCommand, RuntimeEvent, ServerFrame } from "@masscode/contracts";
import { request } from "@/shared/api";

interface StartingThread {
  readonly onCreated: (threadId: string) => void;
  readonly onFailed: (message: string) => void;
}

/** Starts a thread on the host with its first message; the host answers through `callbacks`. */
export function createThread(
  hostId: string,
  hostName: string,
  command: Omit<Extract<ClientCommand, { _tag: "thread.create" }>, "_tag" | "requestId">,
  callbacks: StartingThread,
) {
  return request(
    hostId,
    (requestId) => ClientCommand.cases["thread.create"].make({ requestId, ...command }),
    (reply) => {
      if (ServerFrame.guards["thread.createFailed"](reply)) callbacks.onFailed(reply.message);
      else if (
        ServerFrame.guards.event(reply) &&
        RuntimeEvent.guards["thread.created"](reply.event)
      )
        callbacks.onCreated(reply.event.thread.id);
    },
    () =>
      callbacks.onFailed(
        `Lost the connection to ${hostName} while it started the thread. If it isn't in your threads, send again.`,
      ),
  );
}
