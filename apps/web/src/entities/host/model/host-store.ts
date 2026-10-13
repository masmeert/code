import type { HostStatus, PairedPhone } from "@masscode/contracts";
import { createStore } from "@/shared/lib/store";

/** A remote daemon's connection, where this Mac's lives at the top of `HostsState`. */
interface RemoteHostState {
  readonly status: HostStatus;
  readonly connected: boolean;
  /** Why its daemon can't be used: it runs another version of MassCode. */
  readonly incompatible: string | null;
  readonly dataId: string | null;
  readonly root: boolean;
}

interface HostsState {
  readonly connected: boolean;
  /** Why this Mac's daemon can't be used: it runs another version of MassCode. */
  readonly incompatible: string | null;
  /**
   * Where the data on screen came from: nothing yet, the local cache from the last
   * run (shown while the daemon starts), or the daemon itself.
   */
  readonly source: "none" | "cache" | "daemon";
  /** The daemon database the data on screen belongs to. */
  readonly dataId: string | null;
  /** Phones paired with this Mac's daemon. */
  readonly phones: ReadonlyArray<PairedPhone>;
  /** Remote hosts by SSH alias, each with its own daemon. */
  readonly hosts: Readonly<Record<string, RemoteHostState>>;
}

const store = createStore<HostsState>({
  connected: false,
  incompatible: null,
  source: "none",
  dataId: null,
  phones: [],
  hosts: {},
});

export const useHostStore = store.useStore;

export const getHostState = store.getState;

export const watchHosts = store.watch;

function updateRemote(host: string, update: (current: RemoteHostState) => RemoteHostState) {
  const state = store.getState();
  const current = state.hosts[host];

  if (current) store.setState({ ...state, hosts: { ...state.hosts, [host]: update(current) } });
}

/** The database a host's data belongs to (null: this Mac's). */
export function getDataId(host: string | null) {
  const state = store.getState();

  return host === null ? state.dataId : (state.hosts[host]?.dataId ?? null);
}

/** The host's daemon sent its shell, so its threads can be asked about. */
export function isHostReady(host: string | null) {
  const state = store.getState();

  return host === null ? state.source === "daemon" : state.hosts[host]?.connected === true;
}

export function useIsHostConnected(host: string | null) {
  return store.useStore((state) =>
    host === null ? state.connected : (state.hosts[host]?.connected ?? false),
  );
}

/** Notes that `host`'s daemon (this Mac's when null) runs another version, and how to fix it. */
export function markIncompatible(host: string | null) {
  if (host !== null)
    return updateRemote(host, (current) => ({
      ...current,
      incompatible: `${host} runs a different version of MassCode. Restart it from Settings → Connections.`,
    }));

  store.setState({
    ...store.getState(),
    incompatible:
      "MassCode's daemon is a different version from this window. Quit MassCode and open it again.",
  });
}

export function markDisconnected(host: string | null) {
  if (host !== null) return updateRemote(host, (current) => ({ ...current, connected: false }));

  store.setState({ ...store.getState(), connected: false });
}

/** Shows the last run's data until the daemon answers. */
export function showCachedData(dataId: string) {
  store.setState({ ...store.getState(), source: "cache", dataId });
}

export function receiveShell(
  host: string | null,
  shell: {
    readonly dataId: string;
    readonly root: boolean;
    readonly phones: ReadonlyArray<PairedPhone>;
  },
) {
  if (host !== null)
    return updateRemote(host, (current) => ({
      ...current,
      connected: true,
      incompatible: null,
      dataId: shell.dataId,
      root: shell.root,
    }));

  store.setState({
    ...store.getState(),
    connected: true,
    incompatible: null,
    source: "daemon",
    dataId: shell.dataId,
    phones: shell.phones,
  });
}

export function setPhones(phones: ReadonlyArray<PairedPhone>) {
  store.setState({ ...store.getState(), phones });
}

/** Follows the desktop app's list of remote hosts, keeping what's known about the ones that stay. */
export function setRemoteHosts(
  list: ReadonlyArray<{ readonly alias: string; readonly status: HostStatus }>,
) {
  const state = store.getState();

  store.setState({
    ...state,
    hosts: Object.fromEntries(
      list.map(({ alias, status }) => [
        alias,
        {
          ...(state.hosts[alias] ?? {
            connected: false,
            incompatible: null,
            dataId: null,
            root: false,
          }),
          status,
        },
      ]),
    ),
  });
}
