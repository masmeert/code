import {
  type GitAction,
  type RepoStatus,
  RuntimeEvent,
  type SourceControlStatus,
} from "@masscode/contracts";
import { createStore } from "@/shared/lib/store";

interface RepoState {
  /** Null outside a repo. */
  readonly status: RepoStatus | null;
  /** The commit/push the last update answered, and why it failed. */
  readonly action: GitAction | null;
  readonly error: string | null;
  /** Short hash of the commit that action made, even when its push failed. */
  readonly commit: string | null;
}

interface RepoDiff {
  readonly patch: string;
  readonly truncated: boolean;
  readonly error: string | null;
}

interface BranchList {
  readonly current: string | null;
  readonly branches: ReadonlyArray<string>;
  /** Why the last checkout failed. */
  readonly error: string | null;
}

interface ReposState {
  /** Local branches per repo path, fetched on demand by the branch picker. */
  readonly branches: Readonly<Record<string, BranchList>>;
  /** Files per repo path, fetched when an `@` mention starts. */
  readonly files: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Uncommitted changes per repo path, fetched on demand by the diff panel. */
  readonly diffs: Readonly<Record<string, RepoDiff>>;
  /** Working-tree/upstream state per repo path, fetched on demand by the git menu. */
  readonly repos: Readonly<Record<string, RepoState>>;
  /** The step a commit in flight is on, per repo path, once its message is written. */
  readonly commitPhases: Readonly<Record<string, "committing" | "pushing">>;
  /** One turn's changes, keyed `<threadId>:<messageId>`, fetched by the changes panel. */
  readonly turnDiffs: Readonly<Record<string, RepoDiff>>;
  /** This Mac's GitHub and GitLab CLI status; null until Settings asks for it. */
  readonly sourceControl: ReadonlyArray<SourceControlStatus> | null;
  /** Each remote host's CLI status, by SSH alias. */
  readonly hosts: Readonly<Record<string, ReadonlyArray<SourceControlStatus> | null>>;
}

const store = createStore<ReposState>({
  branches: {},
  files: {},
  diffs: {},
  repos: {},
  commitPhases: {},
  turnDiffs: {},
  sourceControl: null,
  hosts: {},
});

export const useRepoStore = store.useStore;

export function applyRepoEvent(host: string | null, event: RuntimeEvent) {
  const state = store.getState();

  RuntimeEvent.matchOrElse(
    event,
    {
      "git.branches": ({ path, current, branches, error }) =>
        store.setState({
          ...state,
          branches: { ...state.branches, [path]: { current, branches, error } },
        }),
      "git.files": ({ path, files }) =>
        store.setState({ ...state, files: { ...state.files, [path]: files } }),
      "git.diff": ({ path, patch, truncated, error }) =>
        store.setState({
          ...state,
          diffs: { ...state.diffs, [path]: { patch, truncated, error } },
        }),
      "checkpoint.diff": ({ threadId, messageId, patch, truncated, error }) =>
        store.setState({
          ...state,
          turnDiffs: {
            ...state.turnDiffs,
            [`${threadId}:${messageId}`]: { patch, truncated, error },
          },
        }),
      "git.status": ({ path, status, action, error, commit }) => {
        const { [path]: _answered, ...commitPhases } = state.commitPhases;

        store.setState({
          ...state,
          repos: { ...state.repos, [path]: { status, action, error, commit: commit ?? null } },
          commitPhases: action ? commitPhases : state.commitPhases,
        });
      },
      "git.progress": ({ path, phase }) =>
        store.setState({ ...state, commitPhases: { ...state.commitPhases, [path]: phase } }),
      "sourceControl.updated": ({ statuses }) => {
        if (host === null) return store.setState({ ...state, sourceControl: statuses });

        if (host in state.hosts)
          store.setState({ ...state, hosts: { ...state.hosts, [host]: statuses } });
      },
    },
    () => {},
  );
}

/** Follows the desktop app's list of remote hosts, keeping what's known about the ones that stay. */
export function setRemoteHosts(aliases: ReadonlyArray<string>) {
  const { hosts } = store.getState();

  store.setState({
    ...store.getState(),
    hosts: Object.fromEntries(aliases.map((alias) => [alias, hosts[alias] ?? null])),
  });
}
