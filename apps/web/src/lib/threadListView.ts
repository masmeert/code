import { ProviderKind } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { useMemo, useState } from "react";
import { readStored, writeStored } from "./storage.ts";
import { useStore } from "./store.ts";

const ThreadListView = Schema.Struct({
  status: Schema.Literals(["active", "archived", "all"]),
  projects: Schema.Array(Schema.String),
  provider: Schema.Union([ProviderKind, Schema.Literal("all")]),
  activity: Schema.Literals(["any", "day", "week", "month"]),
  groupBy: Schema.Literals(["state", "project", "none"]),
  sortBy: Schema.Literals(["updated", "created"]),
});
export type ThreadListView = typeof ThreadListView.Type;

export const DEFAULT_THREAD_LIST_VIEW: ThreadListView = {
  status: "active",
  projects: [],
  provider: "all",
  activity: "any",
  groupBy: "state",
  sortBy: "updated",
};

const STORAGE_KEY = "masscode.sidebar.view";

export function useThreadListView() {
  const projects = useStore((state) => state.projects);
  // Views saved before a field existed lack it.
  const [stored, setStored] = useState<ThreadListView>(() => ({
    ...DEFAULT_THREAD_LIST_VIEW,
    ...readStored(STORAGE_KEY, ThreadListView.mapFields(Struct.map(Schema.optionalKey)), {}),
  }));
  const view = useMemo(
    () => ({
      ...stored,
      projects: stored.projects.filter((id) => projects.some((project) => project.id === id)),
    }),
    [stored, projects],
  );

  function updateView(patch: Partial<ThreadListView>) {
    const next = { ...stored, ...patch };
    setStored(next);
    writeStored(STORAGE_KEY, ThreadListView, next);
  }

  return [view, updateView] as const;
}
