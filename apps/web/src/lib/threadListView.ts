import type { ProviderKind } from "@apcode/contracts";
import { useMemo, useState } from "react";
import { useStore } from "./store.ts";

export interface ThreadListView {
  readonly status: "active" | "archived" | "all";
  readonly projects: ReadonlyArray<string>;
  readonly provider: ProviderKind | "all";
  readonly activity: "any" | "day" | "week" | "month";
  readonly groupBy: "state" | "project" | "none";
  readonly sortBy: "updated" | "created";
}

export const DEFAULT_THREAD_LIST_VIEW: ThreadListView = {
  status: "active",
  projects: [],
  provider: "all",
  activity: "any",
  groupBy: "state",
  sortBy: "updated",
};

const STORAGE_KEY = "apcode.sidebar.view";

export function useThreadListView() {
  const projects = useStore((state) => state.projects);
  const [stored, setStored] = useState<ThreadListView>(() => {
    try {
      return { ...DEFAULT_THREAD_LIST_VIEW, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
    } catch {
      return DEFAULT_THREAD_LIST_VIEW;
    }
  });
  const view = useMemo(
    () => ({ ...stored, projects: stored.projects.filter((id) => projects.some((project) => project.id === id)) }),
    [stored, projects],
  );

  function update(patch: Partial<ThreadListView>) {
    const next = { ...stored, ...patch };
    setStored(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }

  return [view, update] as const;
}
