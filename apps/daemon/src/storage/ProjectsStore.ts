import { Project } from "@apcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { makeJsonFile } from "./jsonFile.ts";

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
    ) => Effect.Effect<{ readonly project: Project; readonly created: boolean }, ProjectNotFound>;
    readonly remove: (projectId: string) => Effect.Effect<boolean>;
  }
>()("apcode/ProjectsStore") {}

const make = Effect.gen(function* () {
  const file = yield* makeJsonFile("projects.json", Schema.Array(Project), []);
  // Serializes read-modify-write so concurrent commands can't register the same folder twice.
  const lock = yield* Semaphore.make(1);

  const ensure = (rawPath: string) =>
    Effect.gen(function* () {
      const path = resolve(rawPath);
      const projects = yield* file.get;
      const existing = projects.find((p) => p.path === path);
      if (existing) return { project: existing, created: false };

      const isDir = yield* Effect.tryPromise(() => stat(path)).pipe(
        Effect.map((s) => s.isDirectory()),
        Effect.orElseSucceed(() => false),
      );
      if (!isDir)
        return yield* Effect.fail(new ProjectNotFound({ message: `Not a folder: ${path}` }));

      const project: Project = {
        id: crypto.randomUUID(),
        path,
        name: basename(path) || path,
        addedAt: Date.now(),
      };
      yield* file.set([...projects, project]);
      return { project, created: true };
    });

  const remove = (projectId: string) =>
    Effect.gen(function* () {
      const projects = yield* file.get;
      const next = projects.filter((p) => p.id !== projectId);
      if (next.length === projects.length) return false;
      yield* file.set(next);
      return true;
    });

  return ProjectsStore.of({
    list: file.get,
    ensure: (path) => lock.withPermit(ensure(path)),
    remove: (projectId) => lock.withPermit(remove(projectId)),
  });
});

export const layer = Layer.effect(ProjectsStore, make);
