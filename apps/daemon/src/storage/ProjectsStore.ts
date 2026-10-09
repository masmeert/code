import { Project } from "@masscode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { expandHome } from "../folders.ts";
import { readRemoteUrl, readRepoFolder } from "../git.ts";
import { openJsonFile } from "./jsonFile.ts";

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  message: Schema.String,
}) {}

export class ProjectsStore extends Context.Service<
  ProjectsStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<Project>>;
    /** Returns the existing project for `path`, or registers a new one. */
    readonly ensure: (
      path: string,
    ) => Effect.Effect<{ readonly project: Project; readonly isNew: boolean }, ProjectNotFound>;
    readonly remove: (projectId: string) => Effect.Effect<boolean>;
  }
>()("masscode/ProjectsStore") {}

const make = Effect.gen(function* () {
  const file = yield* openJsonFile("projects.json", Schema.Array(Project), []);

  // Serializes read-modify-write so concurrent commands can't register the same folder twice.
  const lock = yield* Semaphore.make(1);

  // Projects work from memory until restart either way, so a failed write is only logged.
  function save(projects: ReadonlyArray<Project>) {
    return file.set(projects).pipe(Effect.catch((error) => Effect.logWarning(error)));
  }

  // Projects added before their repo was read get it once, so they group with their copies elsewhere.
  const saved = yield* file.get;

  if (saved.some((project) => project.remote === undefined || project.folder === undefined))
    yield* save(
      yield* Effect.forEach(saved, (project) =>
        Effect.promise(async () => ({
          ...project,
          remote: project.remote === undefined ? await readRemoteUrl(project.path) : project.remote,
          folder:
            project.folder === undefined ? await readRepoFolder(project.path) : project.folder,
        })),
      ),
    );

  function ensure(rawPath: string) {
    return Effect.gen(function* () {
      const path = resolve(expandHome(rawPath));
      const projects = yield* file.get;
      const existing = projects.find((project) => project.path === path);

      if (existing) return { project: existing, isNew: false };

      const isFolder = yield* Effect.tryPromise(() => stat(path)).pipe(
        Effect.map((stats) => stats.isDirectory()),
        Effect.orElseSucceed(() => false),
      );

      if (!isFolder)
        return yield* Effect.fail(new ProjectNotFound({ message: `Not a folder: ${path}` }));

      const project: Project = {
        id: crypto.randomUUID(),
        path,
        name: basename(path) || path,
        addedAt: Date.now(),
        remote: yield* Effect.promise(() => readRemoteUrl(path)),
        folder: yield* Effect.promise(() => readRepoFolder(path)),
      };

      yield* save([...projects, project]);

      return { project, isNew: true };
    });
  }

  function remove(projectId: string) {
    return Effect.gen(function* () {
      const projects = yield* file.get;
      const next = projects.filter((project) => project.id !== projectId);

      if (next.length === projects.length) return false;

      yield* save(next);

      return true;
    });
  }

  return ProjectsStore.of({
    list: file.get,
    ensure: (path) => lock.withPermit(ensure(path)),
    remove: (projectId) => lock.withPermit(remove(projectId)),
  });
});

export const layer = Layer.effect(ProjectsStore, make);
