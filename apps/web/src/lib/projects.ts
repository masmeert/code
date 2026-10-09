import { type Project, repositoryOf } from "@masscode/contracts";
import { useSyncExternalStore } from "react";
import { addProjectOn, getHosts, getSettings } from "./store.ts";

/** This Mac's folder picker; resolves to the folder, or null if cancelled. */
export async function pickLocalProject() {
  // Browser dev mode has no native dialog.
  const picked = window.desktop
    ? await window.desktop.pickFolder("Add project folder", getSettings().addProjectFolder)
    : window.prompt("Project folder path");
  const path = typeof picked === "string" ? picked.trim() : "";
  if (!path) return null;
  addProjectOn(null, path);
  return path;
}

/** The Add Project dialog waiting on an answer, when one is open. */
let pending: ((path: string | null) => void) | null = null;
const listeners = new Set<() => void>();

function setPending(next: typeof pending) {
  pending = next;
  for (const listener of listeners) listener();
}

export function useAddProjectOpen() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending !== null,
  );
}

/** Answers the open Add Project dialog: the added folder, or null when it was closed. */
export function finishAddProject(path: string | null) {
  pending?.(path);
  setPending(null);
}

/**
 * Asks for a folder and registers it as a project; resolves to its path, or null if
 * cancelled. With remote hosts, a dialog asks which machine it's on first.
 */
export function addProject(): Promise<string | null> {
  if (Object.keys(getHosts()).length === 0) return pickLocalProject();
  finishAddProject(null);
  return new Promise((resolve) => setPending(resolve));
}

/**
 * Which project this is on every machine: its repo, and where it sits in it since a repo can
 * hold several projects. A folder outside git, or in a repo without a remote, is only itself.
 */
export function projectKey(project: Pick<Project, "id" | "remote" | "folder">) {
  return project.remote ? `${repositoryOf(project.remote)}#${project.folder ?? ""}` : project.id;
}
