import {
  type ProviderKind,
  type ProviderStatus,
  RuntimeEvent,
  type ServerFrame,
  type Skill,
} from "@masscode/contracts";
import { create } from "zustand";

export interface SkillList {
  readonly skills: ReadonlyArray<Skill>;
  /** Why the harness couldn't be asked; `skills` then holds what it said last time. */
  readonly error: string | null;
}

interface State {
  /** Each host's harnesses and their models, by host id, for the composer's model label. */
  readonly providers: Readonly<Record<string, ReadonlyArray<ProviderStatus>>>;
  /** Skills per harness and folder (see `getSkillsKey`), by host id, fetched when a `$` mention starts. */
  readonly skills: Readonly<Record<string, Readonly<Record<string, SkillList>>>>;
}

const NO_PROVIDERS: ReadonlyArray<ProviderStatus> = [];

export const useProviderStore = create<State>()(() => ({ providers: {}, skills: {} }));

/** The host's harnesses; empty until its shell arrives. */
export function useHostProviders(hostId: string) {
  return useProviderStore((state) => state.providers[hostId] ?? NO_PROVIDERS);
}

/** Where `skills` keeps a harness's skills for a folder. */
export function getSkillsKey(provider: ProviderKind, path: string) {
  return `${provider}:${path}`;
}

export function applyProviderShell(hostId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  useProviderStore.setState((state) => ({
    providers: { ...state.providers, [hostId]: shell.providers },
  }));
}

export function applyProviderEvent(hostId: string, event: RuntimeEvent) {
  useProviderStore.setState((state) =>
    RuntimeEvent.matchOrElse<Partial<State>>(
      event,
      {
        "providers.updated": ({ providers }) => ({
          providers: { ...state.providers, [hostId]: providers },
        }),
        "skills.listed": ({ provider, path, skills, error }) => ({
          skills: {
            ...state.skills,
            [hostId]: {
              ...state.skills[hostId],
              [getSkillsKey(provider, path)]: { skills, error },
            },
          },
        }),
      },
      () => state,
    ),
  );
}

/** Drops the host's harnesses and their skills. */
export function forgetHostProviders(hostId: string) {
  useProviderStore.setState((state) => {
    const { [hostId]: _providers, ...providers } = state.providers;
    const { [hostId]: _skills, ...skills } = state.skills;

    return { providers, skills };
  });
}
