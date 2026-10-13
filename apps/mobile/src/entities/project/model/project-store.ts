import { type Project, RuntimeEvent, type ServerFrame } from "@masscode/contracts";
import { create } from "zustand";

interface State {
  /** Each host's projects, by host id. */
  readonly projects: Readonly<Record<string, ReadonlyArray<Project>>>;
  /** Files per repo path, by host id, fetched when an `@` mention starts. */
  readonly files: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>>;
}

const NO_PROJECTS: ReadonlyArray<Project> = [];

export const useProjectStore = create<State>()(() => ({ projects: {}, files: {} }));

/** The host's projects; empty until its shell arrives. */
export function useHostProjects(hostId: string) {
  return useProjectStore((state) => state.projects[hostId] ?? NO_PROJECTS);
}

export function applyProjectShell(hostId: string, shell: Extract<ServerFrame, { _tag: "shell" }>) {
  useProjectStore.setState((state) => ({
    projects: { ...state.projects, [hostId]: shell.projects },
  }));
}

export function applyProjectEvent(hostId: string, event: RuntimeEvent) {
  useProjectStore.setState((state) => {
    const projects = state.projects[hostId] ?? NO_PROJECTS;

    return RuntimeEvent.matchOrElse<Partial<State>>(
      event,
      {
        "project.added": ({ project }) => ({
          projects: {
            ...state.projects,
            [hostId]: [...projects.filter((existing) => existing.id !== project.id), project],
          },
        }),
        "project.removed": ({ projectId }) => ({
          projects: {
            ...state.projects,
            [hostId]: projects.filter((project) => project.id !== projectId),
          },
        }),
        "git.files": ({ path, files }) => ({
          files: { ...state.files, [hostId]: { ...state.files[hostId], [path]: files } },
        }),
      },
      () => state,
    );
  });
}

/** Drops the host's projects and their files. */
export function forgetHostProjects(hostId: string) {
  useProjectStore.setState((state) => {
    const { [hostId]: _projects, ...projects } = state.projects;
    const { [hostId]: _files, ...files } = state.files;

    return { projects, files };
  });
}
