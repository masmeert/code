import {
  type KeepAwakeStatus,
  RuntimeEvent,
  type ServerFrame,
  type Settings,
} from "@masscode/contracts";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { connect, type ConnectionLoss, disconnect, hasConnection, reconnect } from "@/shared/api";
import { PairedHost } from "./paired-host.ts";

/** How this phone's link to a host stands. */
export type HostConnection =
  | "connecting"
  | "connected"
  /** Unreachable for now: asleep, MassCode closed, or offline; it keeps retrying. */
  | "offline"
  /** The host unpaired this phone; only pairing again helps. */
  | "unpaired"
  /** The phone and the host run versions that don't understand each other. */
  | "outdated"
  /** Turned off on this phone. */
  | "off";

export interface HostState {
  /** How to reach it, from pairing. */
  readonly paired: PairedHost;
  readonly connection: HostConnection;
  /** The host's database its threads and projects come from. */
  readonly dataId: string | null;
  readonly settings: Settings | null;
  /** Null until it connects, and from a daemon too old to keep its machine awake. */
  readonly keepAwake: KeepAwakeStatus | null;
}

interface State {
  /** The paired hosts have been read from the keychain. */
  readonly isLoaded: boolean;
  readonly hosts: Readonly<Record<string, HostState>>;
}

const decodeKept = Schema.decodeUnknownSync(Schema.Struct({ paired: Schema.Array(PairedHost) }));

function createHost(paired: PairedHost): HostState {
  return {
    paired,
    connection: paired.enabled === false ? "off" : "connecting",
    dataId: null,
    settings: null,
    keepAwake: null,
  };
}

// Only the pairings are kept, in the keychain since anyone with a token or relay key can steer
// that host's agents; the rest comes from each host when it connects.
export const useHostStore = create<State>()(
  persist<State, [], [], { paired: ReadonlyArray<PairedHost> }>(
    () => ({ isLoaded: false, hosts: {} }),
    {
      name: "paired-hosts",
      storage: createJSONStorage(() => ({
        getItem: (key) => SecureStore.getItemAsync(key),
        setItem: (key, value) => SecureStore.setItemAsync(key, value),
        removeItem: (key) => SecureStore.deleteItemAsync(key),
      })),
      partialize: (state) => ({ paired: Object.values(state.hosts).map((host) => host.paired) }),
      merge: (kept, current) => {
        const paired = (() => {
          try {
            return decodeKept(kept).paired;
          } catch {
            return [];
          }
        })();

        return {
          ...current,
          hosts: Object.fromEntries(paired.map((host) => [host.id, createHost(host)])),
        };
      },
      onRehydrateStorage: () => () => {
        useHostStore.setState({ isLoaded: true });

        for (const host of Object.values(useHostStore.getState().hosts))
          if (host.paired.enabled !== false) connect(host.paired);
      },
    },
  ),
);

function updateHost(hostId: string, update: (host: HostState) => HostState) {
  useHostStore.setState((state) => {
    const host = state.hosts[hostId];

    return host ? { hosts: { ...state.hosts, [hostId]: update(host) } } : state;
  });
}

/** What a host's shell says about the host itself: it's connected, to this database, with these settings. */
export function applyHostShell(hostId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  updateHost(hostId, (host) => ({
    ...host,
    connection: "connected",
    dataId: shell.dataId,
    settings: shell.settings,
    keepAwake: shell.keepAwake ?? null,
  }));
}

export function applyHostEvent(hostId: string, event: RuntimeEvent) {
  updateHost(hostId, (host) =>
    RuntimeEvent.matchOrElse<HostState>(
      event,
      {
        "settings.updated": ({ settings }) => ({ ...host, settings }),
        "keepAwake.updated": ({ status }) => ({ ...host, keepAwake: status }),
      },
      () => host,
    ),
  );
}

export function markHostOutdated(hostId: string) {
  updateHost(hostId, (host) => ({ ...host, connection: "outdated" }));
}

export function applyConnectionLoss(hostId: string, loss: ConnectionLoss) {
  updateHost(hostId, (host) => ({
    ...host,
    connection: host.connection === "outdated" ? "outdated" : loss,
  }));
}

/** Tries every host it isn't connected to now, without waiting out the backoff. */
export function reconnectAll() {
  for (const [hostId, host] of Object.entries(useHostStore.getState().hosts))
    if (host.connection === "offline") reconnect(hostId);
}

/** Tries the host now, without waiting out the backoff; also after it unpaired or was outdated. */
export function reconnectHost(hostId: string) {
  if (!hasConnection(hostId)) return;

  updateHost(hostId, (host) => ({ ...host, connection: "connecting" }));
  reconnect(hostId);
}

/**
 * Pairing with a host again replaces what this phone had for it. Another daemon at the same
 * address, on its own data directory, is another host: replacing would strand this one.
 */
export function addHost(paired: PairedHost) {
  for (const host of Object.values(useHostStore.getState().hosts)) {
    const knownDataId = host.paired.dataId ?? host.dataId;

    if (
      knownDataId
        ? knownDataId === paired.dataId
        : Boolean(paired.address) && host.paired.address === paired.address
    )
      removeHost(host.paired.id);
  }

  useHostStore.setState((state) => ({
    hosts: { ...state.hosts, [paired.id]: createHost(paired) },
  }));
  connect(paired);
}

/** Off keeps the pairing but drops the connection and what came over it, until it's turned on again. */
export function setHostEnabled(hostId: string, enabled: boolean) {
  const host = useHostStore.getState().hosts[hostId];

  if (!host || (host.paired.enabled !== false) === enabled) return;

  const paired = { ...host.paired, enabled };

  useHostStore.setState((state) => ({ hosts: { ...state.hosts, [hostId]: createHost(paired) } }));

  if (enabled) connect(paired);
  else disconnect(hostId);
}

/** Forgets the host on this phone; the host still lists the phone until it's unpaired there. */
export function removeHost(hostId: string) {
  disconnect(hostId);
  useHostStore.setState((state) => {
    const { [hostId]: _removed, ...hosts } = state.hosts;

    return { hosts };
  });
}
