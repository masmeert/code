import { ClientCommand, type KeepAwakeStatus, RuntimeEvent } from "@masscode/contracts";
import { send, sendRequest } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

/** This Mac's: remote hosts' daemons never keep their machine awake. Null until its daemon says. */
const store = createStore<{ readonly status: KeepAwakeStatus | null }>({ status: null });

export function useKeepAwake() {
  return store.useStore((state) => state.status);
}

export function getKeepAwake() {
  return store.getState().status;
}

export function receiveKeepAwake(host: string | null, status: KeepAwakeStatus | undefined) {
  if (host === null) store.setState({ status: status ?? null });
}

export function applyKeepAwakeEvent(host: string | null, event: RuntimeEvent) {
  if (RuntimeEvent.guards["keepAwake.updated"](event)) receiveKeepAwake(host, event.status);
}

export function startKeepAwake(minutes: number) {
  send(ClientCommand.cases["keepAwake.start"].make({ minutes }), null);
}

export function stopKeepAwake() {
  send(ClientCommand.cases["keepAwake.stop"].make({}), null);
}

export function setUpKeepAwake() {
  send(ClientCommand.cases["keepAwake.setUp"].make({}), null);
}

export function removeKeepAwake() {
  send(ClientCommand.cases["keepAwake.remove"].make({}), null);
}

/** Running apps first, then installed ones, with what closing the lid would do to each. */
export async function listKeepAwakeApps() {
  const listed = await sendRequest(
    null,
    ClientCommand.cases["keepAwake.listApps"].make({ requestId: crypto.randomUUID() }),
    "keepAwake.apps",
    30_000,
  );

  return listed ?? { apps: [], error: "MassCode didn't answer in time. Try again." };
}
