import {
  type AuthFlow,
  ClientCommand,
  type ProviderKind,
  type ProviderStatus,
  RuntimeEvent,
  type Skill,
  type UsageLimit,
} from "@masscode/contracts";
import { send } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

interface ProviderLimits {
  readonly limits: ReadonlyArray<UsageLimit>;
  readonly error: string | null;
  /** A fresh read is on its way; what's above is from the last one. */
  readonly loading: boolean;
}

/** One daemon's harnesses: their status, sign-in and subscription limits. */
interface HarnessesState {
  readonly providers: ReadonlyArray<ProviderStatus>;
  /** The daemon (or the cache from the last run) has said which harnesses there are. */
  readonly received: boolean;
  readonly authFlows: Partial<Record<ProviderKind, AuthFlow>>;
  /** Subscription rate limits per harness, read when the usage panel opens. */
  readonly limits: Partial<Record<ProviderKind, ProviderLimits>>;
}

interface SkillList {
  readonly skills: ReadonlyArray<Skill>;
  /** Why the harness couldn't be asked; `skills` then holds what it said last time. */
  readonly error: string | null;
}

interface ProvidersState extends HarnessesState {
  /** Each remote host's harnesses, by SSH alias; the fields above are this Mac's. */
  readonly hosts: Readonly<Record<string, HarnessesState>>;
  /** Skills per harness and folder (see `getSkillsKey`), fetched when a `$` mention starts. */
  readonly skills: Readonly<Record<string, SkillList>>;
}

const NO_PROVIDERS: ReadonlyArray<ProviderStatus> = [];

const store = createStore<ProvidersState>({
  providers: [],
  received: false,
  authFlows: {},
  limits: {},
  hosts: {},
  skills: {},
});

export const useProviderStore = store.useStore;

export const watchProviders = store.watch;

/** Where `skills` keeps a harness's skills for a folder. */
export function getSkillsKey(provider: ProviderKind, path: string) {
  return `${provider}:${path}`;
}

/** This Mac's harnesses. */
export function getProviders() {
  return store.getState().providers;
}

/** A host's harnesses; this Mac's for null. */
export function useProviders(host: string | null) {
  return store.useStore((state) =>
    host === null ? state.providers : (state.hosts[host]?.providers ?? NO_PROVIDERS),
  );
}

/** False until the host has said which harnesses it has: an empty list then means "not known yet". */
export function useHasHarnessStatus(host: string | null) {
  return store.useStore((state) =>
    host === null ? state.received : (state.hosts[host]?.received ?? false),
  );
}

export function useAuthFlow(host: string | null, provider: ProviderKind) {
  return store.useStore((state) =>
    host === null ? state.authFlows[provider] : state.hosts[host]?.authFlows[provider],
  );
}

export function useLimits(host: string | null, provider: ProviderKind) {
  return store.useStore((state) =>
    host === null ? state.limits[provider] : state.hosts[host]?.limits[provider],
  );
}

/** Changes `host`'s harnesses (this Mac's for null); a host the app doesn't follow is left alone. */
function updateHarnesses(host: string | null, update: (current: HarnessesState) => HarnessesState) {
  const state = store.getState();

  if (host === null) return store.setState({ ...state, ...update(state) });

  const current = state.hosts[host];

  if (current) store.setState({ ...state, hosts: { ...state.hosts, [host]: update(current) } });
}

export function readLimits(provider: ProviderKind, host: string | null) {
  updateHarnesses(host, (current) => ({
    ...current,
    limits: {
      ...current.limits,
      [provider]: { limits: current.limits[provider]?.limits ?? [], error: null, loading: true },
    },
  }));
  send(ClientCommand.cases["provider.readLimits"].make({ provider }), host);
}

export function receiveProviders(host: string | null, providers: ReadonlyArray<ProviderStatus>) {
  updateHarnesses(host, (current) => ({ ...current, providers, received: true }));
}

export function applyProviderEvent(host: string | null, event: RuntimeEvent) {
  const before = store.getState();

  RuntimeEvent.matchOrElse(
    event,
    {
      "providers.updated": ({ providers }) => receiveProviders(host, providers),
      "auth.flow": ({ flow }) =>
        updateHarnesses(host, (current) => ({
          ...current,
          authFlows: { ...current.authFlows, [flow.provider]: flow },
        })),
      "provider.limits": ({ provider, limits, error }) =>
        updateHarnesses(host, (current) => ({
          ...current,
          limits: { ...current.limits, [provider]: { limits, error, loading: false } },
        })),
      "skills.listed": ({ provider, path, skills, error }) =>
        store.setState({
          ...before,
          skills: { ...before.skills, [getSkillsKey(provider, path)]: { skills, error } },
        }),
    },
    () => {},
  );

  // A remote host's CLI can't open this Mac's browser, so its sign-in page opens here.
  if (
    host !== null &&
    RuntimeEvent.guards["auth.flow"](event) &&
    event.flow.url &&
    before.hosts[host]?.authFlows[event.flow.provider]?.url !== event.flow.url
  )
    window.open(event.flow.url, "_blank");
}

/** Follows the desktop app's list of remote hosts, keeping what's known about the ones that stay. */
export function setRemoteHosts(aliases: ReadonlyArray<string>) {
  const { hosts } = store.getState();

  store.setState({
    ...store.getState(),
    hosts: Object.fromEntries(
      aliases.map((alias) => [
        alias,
        hosts[alias] ?? { providers: NO_PROVIDERS, received: false, authFlows: {}, limits: {} },
      ]),
    ),
  });
}
