import { type ClientCommand, PROTOCOL_VERSION, ServerFrame } from "@masscode/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { CliError, readServiceEndpoint } from "./service.ts";

const decodeServerFrame = Schema.decodeUnknownResult(Schema.fromJsonString(ServerFrame));

type ShellFrame = Extract<ServerFrame, { _tag: "shell" }>;

/** A connection to this machine's service, as the local app would make one. */
export interface LocalDaemon {
  readonly shell: ShellFrame;
  readonly send: (command: ClientCommand) => void;
  /** Resolves with the first frame `match` maps to a value; rejects after `timeoutMs`. */
  readonly waitFor: <A>(
    match: (frame: ServerFrame) => A | undefined,
    timeoutMs: number,
  ) => Promise<A>;
  readonly close: () => void;
}

/** Null when the service isn't running; `waitMs` gives a just-started one time to listen. */
export async function openLocalDaemon(waitMs = 0) {
  const deadline = Date.now() + waitMs;

  for (;;) {
    const endpoint = await readServiceEndpoint();
    const daemon = endpoint ? await connect(endpoint.port, endpoint.token).catch(() => null) : null;

    if (daemon || Date.now() >= deadline) return daemon;

    await Bun.sleep(500);
  }
}

export async function openLocalDaemonOrFail() {
  const daemon = await openLocalDaemon(2000);

  if (!daemon)
    throw new CliError("MassCode isn't running on this machine. Run `masscode connect` first.");

  return daemon;
}

function connect(port: number, token: string) {
  return new Promise<LocalDaemon>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?protocol=${PROTOCOL_VERSION}`, [
      `masscode.${token}`,
    ]);

    const listeners = new Set<(frame: ServerFrame) => void>();

    socket.addEventListener("message", (message) => {
      const decoded = decodeServerFrame(message.data);

      if (Result.isFailure(decoded)) return;

      const frame = decoded.success;

      if (ServerFrame.guards.shell(frame))
        resolve({
          shell: frame,
          send: (command) => socket.send(JSON.stringify(command)),
          waitFor: (match, timeoutMs) =>
            new Promise((resolveMatch, rejectMatch) => {
              const timeout = setTimeout(() => {
                listeners.delete(listener);
                rejectMatch(new CliError("MassCode didn't answer in time. Run this again."));
              }, timeoutMs);

              function listener(candidate: ServerFrame) {
                const value = match(candidate);

                if (value === undefined) return;

                clearTimeout(timeout);
                listeners.delete(listener);
                resolveMatch(value);
              }

              listeners.add(listener);
            }),
          close: () => socket.close(),
        });

      for (const listener of listeners) listener(frame);
    });

    socket.addEventListener("close", (event) =>
      reject(new CliError(event.reason || "MassCode closed the connection.")),
    );
    socket.addEventListener("error", () => reject(new CliError("Couldn't reach MassCode.")));
  });
}
