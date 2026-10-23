import { ClientCommand, RuntimeEvent, type Service } from "@masscode/contracts";
import { useMemo } from "react";
import { sendRequest } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

/** A service, with the host whose daemon reported it: each daemon sees its own machine's. */
export interface HostedService extends Service {
  readonly host: string | null;
}

/** By host; this Mac's under "". */
const store = createStore<Readonly<Record<string, ReadonlyArray<HostedService>>>>({});

export function useServices() {
  const byHost = store.useStore((state) => state);

  return useMemo(() => Object.values(byHost).flat(), [byHost]);
}

export function receiveServices(host: string | null, services: ReadonlyArray<Service> | undefined) {
  store.setState({
    ...store.getState(),
    [host ?? ""]: (services ?? []).map((service) => ({ ...service, host })),
  });
}

export function applyServiceEvent(host: string | null, event: RuntimeEvent) {
  if (RuntimeEvent.guards["services.updated"](event)) receiveServices(host, event.services);
}

/** A disconnected host's services can't be stopped from here, nor known to be still running. */
export function forgetServices(host: string | null) {
  receiveServices(host, []);
}

/** Resolves to why the service couldn't be stopped, or null once it's gone. */
export async function killService(service: HostedService) {
  const reply = await sendRequest(
    service.host,
    ClientCommand.cases["service.kill"].make({
      requestId: crypto.randomUUID(),
      threadId: service.threadId,
      pid: service.pid,
    }),
    "service.killed",
    15_000,
  );

  return reply ? reply.error : "MassCode didn't answer in time. Try again.";
}
