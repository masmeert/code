import { ClientCommand, type Project, RuntimeEvent } from "@masscode/contracts";
import { send } from "@/shared/api";
import { createStore } from "@/shared/lib/store";

interface ProjectsState {
  readonly projects: ReadonlyArray<Project>;
  /** The remote host each remote project is on; a project missing here is on this Mac. */
  readonly projectHosts: Readonly<Record<string, string>>;
}

const store = createStore<ProjectsState>({ projects: [], projectHosts: {} });

export const useProjectStore = store.useStore;

export const getProjectState = store.getState;

export const watchProjects = store.watch;

/** Folders added on a remote host whose project hasn't arrived yet, so commands for them go there. */
const pendingPaths = new Map<string, string>();

/** The remote host a project is on; null for this Mac. */
export function getProjectHost(projectId: string) {
  return store.getState().projectHosts[projectId] ?? null;
}

export function useProjectHost(projectId: string) {
  return store.useStore((state) => state.projectHosts[projectId] ?? null);
}

/** Whether a project is on `host` (null: this Mac). */
export function isProjectOnHost(host: string | null, projectId: string) {
  return getProjectHost(projectId) === host;
}

/** The host of the deepest project holding `path`, or undefined when no project does. */
export function findProjectHostForPath(path: string) {
  const project = store
    .getState()
    .projects.filter(
      (candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];

  return project ? getProjectHost(project.id) : undefined;
}

/** The host a folder was just added or cloned on, while its project is on its way. */
export function findPendingPathHost(path: string) {
  return pendingPaths.get(path) ?? null;
}

/** Registers a folder on `host` as a project. */
export function addProjectOn(host: string | null, path: string) {
  if (host !== null) pendingPaths.set(path, host);
  send(ClientCommand.cases["project.add"].make({ path }), host);
}

/** Adds the git repos in `folder` on `host` as projects there. */
export function scanProjects(host: string, folder: string) {
  send(ClientCommand.cases["project.scan"].make({ path: folder }), host);
}

export function rememberPendingPath(path: string, host: string) {
  pendingPaths.set(path, host);
}

export function showCachedProjects(projects: ReadonlyArray<Project>) {
  store.setState({ ...store.getState(), projects });
}

/** Replaces one host's projects with what its daemon sent; other hosts' stay. */
export function receiveProjects(host: string | null, projects: ReadonlyArray<Project>) {
  const state = store.getState();

  store.setState({
    projects: [
      ...state.projects.filter((project) => !isProjectOnHost(host, project.id)),
      ...projects,
    ],
    projectHosts:
      host === null
        ? state.projectHosts
        : {
            ...Object.fromEntries(
              Object.entries(state.projectHosts).filter(([, projectHost]) => projectHost !== host),
            ),
            ...Object.fromEntries(projects.map((project) => [project.id, host])),
          },
  });
}

/** Drops a removed host's projects. */
export function forgetHostProjects(host: string) {
  const state = store.getState();

  store.setState({
    projects: state.projects.filter((project) => !isProjectOnHost(host, project.id)),
    projectHosts: Object.fromEntries(
      Object.entries(state.projectHosts).filter(([, projectHost]) => projectHost !== host),
    ),
  });
}

export function applyProjectEvent(host: string | null, event: RuntimeEvent) {
  const state = store.getState();

  RuntimeEvent.matchOrElse(
    event,
    {
      "project.added": ({ project }) =>
        store.setState({
          projects: [...state.projects.filter((existing) => existing.id !== project.id), project],
          projectHosts:
            host === null ? state.projectHosts : { ...state.projectHosts, [project.id]: host },
        }),
      "project.removed": ({ projectId }) => {
        const { [projectId]: _host, ...projectHosts } = state.projectHosts;

        store.setState({
          projects: state.projects.filter((project) => project.id !== projectId),
          projectHosts,
        });
      },
    },
    () => {},
  );
}
