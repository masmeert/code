import {
  ClientCommand,
  DEFAULT_SETTINGS,
  type ProviderKind,
  type ProviderSettings,
  RuntimeEvent,
  type Settings,
} from "@masscode/contracts";
import { send } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

interface SettingsState {
  /** This Mac's settings, which remote hosts follow. */
  readonly settings: Settings;
  /** False until the cache or the daemon has said what they are; defaults until then. */
  readonly isLoaded: boolean;
  /** Each remote host's own settings, by SSH alias; null until it connects. */
  readonly hosts: Readonly<Record<string, Settings | null>>;
}

const store = createStore<SettingsState>({
  settings: DEFAULT_SETTINGS,
  isLoaded: false,
  hosts: {},
});

export const watchSettings = store.watch;

export function useSettings() {
  return store.useStore((state) => state.settings);
}

export function useSetting<A>(select: (settings: Settings) => A): A {
  return store.useStore((state) => select(state.settings));
}

export function getSettings() {
  return store.getState().settings;
}

/** Remote hosts follow this Mac's settings, except their harness launch settings, which are per machine. */
export function syncSettings(host: string) {
  const state = store.getState();
  const remote = state.hosts[host];

  if (!remote || !state.isLoaded) return;

  const settings = { ...state.settings, providers: remote.providers };

  if (JSON.stringify(settings) !== JSON.stringify(remote))
    send(ClientCommand.cases["settings.update"].make({ settings }), host);
}

/** Applies settings locally right away (theme etc. shouldn't wait on the daemon), then persists them. */
export function updateSettings(settings: Settings) {
  store.setState({ ...store.getState(), settings });
  send(ClientCommand.cases["settings.update"].make({ settings }), null);

  for (const host of Object.keys(store.getState().hosts)) syncSettings(host);
}

/** Changes some of one harness's Settings, keeping the rest. */
export function updateHarness(provider: ProviderKind, patch: Partial<ProviderSettings>) {
  const { settings } = store.getState();
  updateSettings({
    ...settings,
    providers: {
      ...settings.providers,
      [provider]: { ...settings.providers[provider], ...patch },
    },
  });
}

/** Where `host` keeps its projects: the folder set for it, or its home. */
export function getHostProjectsFolder(host: string) {
  return store.getState().settings.hostProjectFolders?.[host] || "~";
}

export function showCachedSettings(settings: Settings) {
  store.setState({ ...store.getState(), settings, isLoaded: true });
}

export function receiveSettings(host: string | null, settings: Settings) {
  const state = store.getState();

  if (host === null) return store.setState({ ...state, settings, isLoaded: true });

  if (host in state.hosts)
    store.setState({ ...state, hosts: { ...state.hosts, [host]: settings } });
}

export function applySettingsEvent(host: string | null, event: RuntimeEvent) {
  if (!RuntimeEvent.guards["settings.updated"](event)) return;

  const state = store.getState();

  if (host !== null) return receiveSettings(host, event.settings);

  // Usually the echo of our own updateSettings: keeping the old object spares every settings reader a re-render.
  if (JSON.stringify(event.settings) !== JSON.stringify(state.settings))
    store.setState({ ...state, settings: event.settings });
}

/** Follows the desktop app's list of remote hosts. */
export function setRemoteHosts(aliases: ReadonlyArray<string>) {
  const { hosts } = store.getState();

  store.setState({
    ...store.getState(),
    hosts: Object.fromEntries(aliases.map((alias) => [alias, hosts[alias] ?? null])),
  });
}
